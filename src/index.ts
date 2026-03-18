import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bearerAuth } from 'hono/bearer-auth'
import { exec } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const app = new Hono()
let cachedYtDlpVersion: Promise<string | null> | null = null

// CORS for your Vercel domain
app.use('/*', cors())

// Simple bearer token auth
const API_TOKEN = process.env.YT_DLP_API_TOKEN || 'dev-token'
app.use('/api/*', bearerAuth({ token: API_TOKEN }))

let cachedCookiesArg: string | null = null
let cachedCookiesSource: 'file' | 'b64' | 'raw' | 'none' | null = null

/**
 * Build a safe yt-dlp cookies flag from env.
 *
 * Supported env vars:
 * - YT_DLP_COOKIES_FILE: absolute path to a cookies.txt file available in the container
 * - YT_DLP_COOKIES_B64: base64-encoded Netscape cookies.txt content
 * - YT_DLP_COOKIES: raw Netscape cookies.txt content (multiline)
 *
 * IMPORTANT: Never log cookies content.
 */
async function getYtDlpCookiesArg(): Promise<string> {
  if (cachedCookiesArg !== null) return cachedCookiesArg

  const cookiesFile = process.env.YT_DLP_COOKIES_FILE
  if (cookiesFile) {
    cachedCookiesArg = ` --cookies "${cookiesFile}"`
    cachedCookiesSource = 'file'
    return cachedCookiesArg
  }

  const cookiesB64 = process.env.YT_DLP_COOKIES_B64
  const cookiesRaw = process.env.YT_DLP_COOKIES

  const cookiesContent =
    typeof cookiesB64 === 'string' && cookiesB64.trim()
      ? Buffer.from(cookiesB64.replace(/\s+/g, ''), 'base64').toString('utf8')
      : cookiesRaw

  if (!cookiesContent || !cookiesContent.trim()) {
    cachedCookiesArg = ''
    cachedCookiesSource = 'none'
    return cachedCookiesArg
  }

  // Write cookies to a temp file (Railway containers have a writable /tmp).
  const cookiesPath = '/tmp/yt-dlp-cookies.txt'
  await writeFile(cookiesPath, cookiesContent, { encoding: 'utf8', mode: 0o600 })
  cachedCookiesArg = ` --cookies "${cookiesPath}"`
  cachedCookiesSource = typeof cookiesB64 === 'string' && cookiesB64.trim() ? 'b64' : 'raw'
  return cachedCookiesArg
}

function getYtDlpVerboseArg(): string {
  return process.env.YT_DLP_VERBOSE === '1' ? ' --verbose' : ''
}

function getCookiesConfig(): {
  enabled: boolean
  source: 'file' | 'b64' | 'raw' | 'none'
  fileSet: boolean
  b64Length: number
  rawLength: number
} {
  const cookiesFile = process.env.YT_DLP_COOKIES_FILE
  const cookiesB64 = process.env.YT_DLP_COOKIES_B64
  const cookiesRaw = process.env.YT_DLP_COOKIES

  const fileSet = typeof cookiesFile === 'string' && cookiesFile.trim().length > 0
  const b64Length = typeof cookiesB64 === 'string' ? cookiesB64.trim().length : 0
  const rawLength = typeof cookiesRaw === 'string' ? cookiesRaw.trim().length : 0

  if (fileSet) return { enabled: true, source: 'file', fileSet, b64Length, rawLength }
  if (b64Length > 0) return { enabled: true, source: 'b64', fileSet, b64Length, rawLength }
  if (rawLength > 0) return { enabled: true, source: 'raw', fileSet, b64Length, rawLength }
  return { enabled: false, source: 'none', fileSet, b64Length, rawLength }
}

/**
 * Build a short per-request identifier for debug correlation.
 */
function createDebugRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Keep stderr/message payloads compact and safe for debug logs.
 */
function summarizeDebugText(value: unknown, maxLength = 280): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

/**
 * Classify common yt-dlp failure patterns to validate runtime hypotheses faster.
 */
function classifyYtDlpFailure(value: unknown): string {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  if (!text) return 'unknown'
  if (text.includes(`sign in to confirm you're not a bot`) || text.includes('use --cookies')) return 'bot_check'
  if (text.includes('membership') || text.includes('private') || text.includes('login required')) return 'auth_required'
  if (text.includes('channel is not available') || text.includes('this channel does not exist')) return 'channel_unavailable'
  if (text.includes('unable to recognize tab page') || text.includes('tab') || text.includes('/videos')) return 'tab_resolution'
  if (text.includes('timed out') || text.includes('timeout')) return 'timeout'
  if (text.includes('unable to extract') || text.includes('unsupported url') || text.includes('extractor')) return 'extractor_failure'
  return 'other'
}

/**
 * Read and cache the installed yt-dlp version for diagnostics.
 */
async function getYtDlpVersion(): Promise<string | null> {
  if (!cachedYtDlpVersion) {
    cachedYtDlpVersion = execAsync('yt-dlp --version', {
      maxBuffer: 1024 * 1024,
      timeout: 5000,
    })
      .then(({ stdout }) => summarizeDebugText(stdout, 64))
      .catch(() => null)
  }

  return cachedYtDlpVersion
}

// Health check
app.get('/', async (c) =>
  c.json({
    status: 'ok',
    service: 'yt-dlp-api',
    ytDlp: {
      version: await getYtDlpVersion(),
      cookiesEnabled: getCookiesConfig().enabled,
      cookiesSource: getCookiesConfig().source,
      cookiesFileSet: getCookiesConfig().fileSet,
      cookiesB64Length: getCookiesConfig().b64Length,
      cookiesRawLength: getCookiesConfig().rawLength,
      verbose: process.env.YT_DLP_VERBOSE === '1',
    },
  })
)

// Startup diagnostics (safe: lengths only, never the cookie content).
const cfg = getCookiesConfig()
console.log('[yt-dlp-api] cookies config:', {
  enabled: cfg.enabled,
  source: cfg.source,
  fileSet: cfg.fileSet,
  b64Length: cfg.b64Length,
  rawLength: cfg.rawLength,
  verbose: process.env.YT_DLP_VERBOSE === '1',
})

type YtDlpThumbnail = {
  url?: string
  width?: number
  height?: number
  preference?: number
  id?: string
}

/**
 * Pick a YouTube thumbnail URL from yt-dlp output.
 *
 * Priority:
 * - hqdefault (best compromise for UI)
 * - mqdefault
 * - maxresdefault
 * - data.thumbnail
 * - best scored from data.thumbnails
 * - fallback i.ytimg.com with hqdefault
 */
function pickThumbnailUrl(data: Record<string, unknown>): string | null {
  const videoId = typeof data.id === 'string' ? data.id : null
  const direct = typeof data.thumbnail === 'string' ? data.thumbnail : null

  const thumbnails = (Array.isArray(data.thumbnails) ? data.thumbnails : []) as YtDlpThumbnail[]

  const findByUrl = (re: RegExp): string | null => {
    for (const t of thumbnails) {
      if (typeof t?.url === 'string' && re.test(t.url)) return t.url
    }
    return null
  }

  const hq = findByUrl(/hqdefault/i)
  if (hq) return hq

  const mq = findByUrl(/mqdefault/i)
  if (mq) return mq

  const maxres = findByUrl(/maxresdefault/i)
  if (maxres) return maxres

  if (direct) return direct

  const scored = thumbnails
    .map((t) => {
      const url = typeof t?.url === 'string' ? t.url : null
      if (!url) return null
      const w = typeof t.width === 'number' ? t.width : 0
      const h = typeof t.height === 'number' ? t.height : 0
      const preference = typeof t.preference === 'number' ? t.preference : 0
      const score = w > 0 && h > 0 ? w * h : preference
      return { url, score }
    })
    .filter(Boolean) as Array<{ url: string; score: number }>

  scored.sort((a, b) => b.score - a.score)
  if (scored[0]?.url) return scored[0].url

  if (videoId) return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  return null
}

/**
 * Normalize a user-provided sinceDate into a safe yt-dlp --dateafter value.
 *
 * We accept:
 * - YYYY-MM-DD (or ISO strings that start with it) → YYYYMMDD
 * - YYYYMMDD → YYYYMMDD
 * - Relative forms: now|today|yesterday[-N{day|week|month|year}(s)]
 *
 * Returns null when the value is not recognized/safe (prevents shell injection).
 */
function normalizeSinceDateForYtDlpDateafter(input: string): string | null {
  const s = input.trim()
  if (!s) return null

  // ISO-ish date-only prefix: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss...
  const isoPrefix = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoPrefix) {
    const [, y, m, d] = isoPrefix
    return `${y}${m}${d}`
  }

  // Already normalized
  if (/^\d{8}$/.test(s)) return s

  // Relative forms used by yt-dlp for date filters (same as --date/--dateafter docs)
  const rel = s.match(/^(now|today|yesterday)(?:-([1-9]\d*)(day|week|month|year)s?)?$/)
  if (rel) {
    const [, base, n, unit] = rel
    if (!n || !unit) return base
    const needsPlural = n !== '1' && !unit.endsWith('s')
    return `${base}-${n}${needsPlural ? `${unit}s` : unit}`
  }

  return null
}

/**
 * Parse sinceDate into a local midnight Date for JS-side filtering.
 *
 * This is intentionally aligned with the publishedAtDate creation below
 * (new Date(year, monthIndex, day)) to avoid timezone surprises that can
 * happen when parsing YYYY-MM-DD as UTC.
 */
function parseSinceDateToLocalDate(input: string): Date | null {
  const s = input.trim()
  if (!s) return null

  const isoPrefix = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoPrefix) {
    const [, y, m, d] = isoPrefix
    return new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10))
  }

  const ymd = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (ymd) {
    const [, y, m, d] = ymd
    return new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10))
  }

  return null
}

/**
 * Extract video metadata
 * POST /api/video
 * Body: { url: string }
 */
app.post('/api/video', async (c) => {
  const { url } = await c.req.json<{ url: string }>()

  if (!url) {
    return c.json({ error: 'Missing url parameter' }, 400)
  }

  try {
    const cookiesArg = await getYtDlpCookiesArg()
    const verboseArg = getYtDlpVerboseArg()
    // Some YouTube responses can expose only "unplayable"/DRM formats depending on region/IP/account,
    // which may cause yt-dlp to fail format selection even when we only want metadata.
    // These flags make metadata extraction more resilient.
    const resilientFlags = ` --allow-unplayable-formats --ignore-no-formats-error --no-playlist`
    const command = `yt-dlp --dump-json --skip-download --no-warnings${verboseArg}${cookiesArg}${resilientFlags} --write-comments --extractor-args "youtube:comment_sort=top;max_comments=5" "${url}"`

    const { stdout } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60000,
    })

    const data = JSON.parse(stdout)

    // Find pinned comment
    let pinnedComment: string | null = null
    if (data.comments && data.comments.length > 0) {
      const pinned = data.comments.find((c: { is_pinned?: boolean }) => c.is_pinned)
      if (pinned) {
        pinnedComment = pinned.text
      }
    }

    // Parse upload date (format: YYYYMMDD)
    let publishedAt: string | null = null
    if (data.upload_date) {
      const year = data.upload_date.substring(0, 4)
      const month = data.upload_date.substring(4, 6)
      const day = data.upload_date.substring(6, 8)
      publishedAt = `${year}-${month}-${day}`
    }

    const thumbnailUrl = pickThumbnailUrl(data)

    return c.json({
      id: data.id,
      title: data.title,
      description: data.description || null,
      pinnedComment,
      channelId: data.channel_id,
      channelName: data.channel || data.uploader || 'Unknown',
      channelUrl: data.channel_url || data.uploader_url || `https://www.youtube.com/channel/${data.channel_id}`,
      thumbnailUrl,
      publishedAt,
      viewCount: data.view_count ?? null,
      languageCode: data.language || null,
      duration: data.duration ?? null,
      url: data.webpage_url,
    })
  } catch (error) {
    const err = error as { message?: string; stderr?: string }
    console.error('[yt-dlp] Video extraction failed:', err.stderr || err.message)
    return c.json(
      {
        error: 'Failed to extract video metadata',
        details: err.stderr || err.message,
        ytDlp: {
          cookiesEnabled: getCookiesConfig().enabled,
          cookiesSource: cachedCookiesSource ?? getCookiesConfig().source,
          verbose: process.env.YT_DLP_VERBOSE === '1',
        },
      },
      500
    )
  }
})

/**
 * Extract channel metadata
 * POST /api/channel
 * Body: { url: string }
 */
app.post('/api/channel', async (c) => {
  const { url } = await c.req.json<{ url: string }>()

  if (!url) {
    return c.json({ error: 'Missing url parameter' }, 400)
  }

  try {
    const debugRunId = createDebugRunId('channel')
    const cookiesArg = await getYtDlpCookiesArg()
    const verboseArg = getYtDlpVerboseArg()
    // Prefer the /about tab and flat playlist mode to avoid video format checks.
    // Some channels have a first video that triggers "Requested format is not available"
    // even though we only need channel-level metadata.
    const normalizedUrl = url.replace(/\/+$/, '')
    const aboutUrl = normalizedUrl.endsWith('/about') ? normalizedUrl : `${normalizedUrl}/about`
    const commonFlags = ` --ignore-errors --no-abort-on-error --flat-playlist --playlist-end 1`
    const command = `yt-dlp --dump-single-json --skip-download --no-warnings${verboseArg}${cookiesArg}${commonFlags} "${aboutUrl}"`
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/52f648b0-5232-4d77-a7e9-77a4d95956d2',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'181fb7'},body:JSON.stringify({sessionId:'181fb7',runId:debugRunId,hypothesisId:'H2',location:'src/index.ts:377',message:'channel metadata request',data:{url,normalizedUrl,aboutUrl,cookiesEnabled:getCookiesConfig().enabled,cookiesSource:cachedCookiesSource ?? getCookiesConfig().source,verbose:process.env.YT_DLP_VERBOSE === '1'},timestamp:Date.now()})}).catch(()=>{})
    // #endregion

    const { stdout } = await execAsync(command, {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 30000,
    })

    // yt-dlp should output a single JSON object with --dump-single-json.
    // Still be resilient to trailing newlines or unexpected multi-line output.
    const raw = stdout.trim()
    const firstLine = raw.includes('\n') ? raw.split('\n').find(Boolean) ?? raw : raw
    const data = JSON.parse(firstLine)
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/52f648b0-5232-4d77-a7e9-77a4d95956d2',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'181fb7'},body:JSON.stringify({sessionId:'181fb7',runId:debugRunId,hypothesisId:'H2',location:'src/index.ts:389',message:'channel metadata success',data:{resolvedId:data.channel_id || data.uploader_id || data.id,hasDescription:Boolean(data.description),subscriberCount:data.channel_follower_count ?? data.subscriber_count ?? null,videoCount:data.playlist_count ?? data.video_count ?? null},timestamp:Date.now()})}).catch(()=>{})
    // #endregion

    return c.json({
      id: data.channel_id || data.uploader_id || data.id,
      name: data.channel || data.uploader || data.title || 'Unknown',
      url: data.channel_url || data.uploader_url || data.webpage_url || url,
      description: data.description || null,
      subscriberCount: data.channel_follower_count ?? data.subscriber_count ?? null,
      videoCount: data.playlist_count ?? data.video_count ?? null,
    })
  } catch (error) {
    const err = error as { message?: string; stderr?: string }
    const failureCategory = classifyYtDlpFailure(err.stderr || err.message)
    const stderrSnippet = summarizeDebugText(err.stderr)
    const messageSnippet = summarizeDebugText(err.message)
    const ytDlpVersion = await getYtDlpVersion()
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/52f648b0-5232-4d77-a7e9-77a4d95956d2',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'181fb7'},body:JSON.stringify({sessionId:'181fb7',runId:createDebugRunId('channel-error'),hypothesisId:'H2',location:'src/index.ts:406',message:'channel metadata failure',data:{failureCategory,stderrSnippet,messageSnippet,cookiesEnabled:getCookiesConfig().enabled,cookiesSource:cachedCookiesSource ?? getCookiesConfig().source,ytDlpVersion},timestamp:Date.now()})}).catch(()=>{})
    // #endregion
    console.error('[yt-dlp] Channel extraction failed:', err.stderr || err.message)
    return c.json(
      {
        error: 'Failed to extract channel metadata',
        details: err.stderr || err.message,
        failureCategory,
        stderrSnippet,
        messageSnippet,
        request: {
          url,
        },
        ytDlp: {
          version: ytDlpVersion,
          cookiesEnabled: getCookiesConfig().enabled,
          cookiesSource: cachedCookiesSource ?? getCookiesConfig().source,
          verbose: process.env.YT_DLP_VERBOSE === '1',
        },
      },
      500
    )
  }
})

/**
 * Extract channel videos list
 * POST /api/channel/videos
 * Body: { url: string, sinceDate?: string, maxVideos?: number }
 */
app.post('/api/channel/videos', async (c) => {
  const { url, sinceDate, maxVideos = 100 } = await c.req.json<{
    url: string
    sinceDate?: string
    maxVideos?: number
  }>()

  if (!url) {
    return c.json({ error: 'Missing url parameter' }, 400)
  }

  try {
    const debugRunId = createDebugRunId('channel-videos')
    const videosUrl = url.includes('/videos') ? url : `${url}/videos`
    const dateafter = sinceDate ? normalizeSinceDateForYtDlpDateafter(sinceDate) : null
    const cookiesArg = await getYtDlpCookiesArg()
    const verboseArg = getYtDlpVerboseArg()
    // Keep the command resilient: channel feeds can contain unavailable videos.
    // Without `--ignore-errors`, yt-dlp can exit non-zero and the API would return 500.
    const commonFlags = ` --ignore-errors --no-abort-on-error`
    // Use flat playlist mode for speed and to reduce the chance of triggering YouTube anti-bot checks.
    // We still accept `sinceDate` and apply it in our own filtering logic below.
    const extractorArgs = ` --extractor-args "youtubetab:approximate_date"`
    const command = `yt-dlp --flat-playlist --dump-json --no-warnings${verboseArg}${cookiesArg}${commonFlags} --playlist-end ${maxVideos}${extractorArgs} "${videosUrl}"`
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/52f648b0-5232-4d77-a7e9-77a4d95956d2',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'181fb7'},body:JSON.stringify({sessionId:'181fb7',runId:debugRunId,hypothesisId:'H1',location:'src/index.ts:451',message:'channel videos request',data:{url,videosUrl,sinceDate:sinceDate ?? null,dateafter,maxVideos,cookiesEnabled:getCookiesConfig().enabled,cookiesSource:cachedCookiesSource ?? getCookiesConfig().source,verbose:process.env.YT_DLP_VERBOSE === '1'},timestamp:Date.now()})}).catch(()=>{})
    // #endregion

    const { stdout } = await execAsync(command, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120000,
    })

    const lines = stdout.trim().split('\n').filter(Boolean)
    const videos: Array<{
      id: string
      title: string
      url: string
      publishedAt: string | null
      viewCount: number | null
      duration: number | null
    }> = []

    const sinceDateObj = sinceDate ? parseSinceDateToLocalDate(sinceDate) : null
    let filteredOut = 0
    let filteredOutMissingDate = 0
    let minPublishedAt: string | null = null
    let maxPublishedAt: string | null = null
    const sinceDateStr = sinceDateObj && sinceDate ? (sinceDate.match(/^(\d{4})-(\d{2})-(\d{2})/)?.[0] ?? null) : null

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)

        // Parse upload date
        let publishedAt: string | null = null
        let publishedAtDate: Date | null = null
        if (entry.upload_date) {
          const year = entry.upload_date.substring(0, 4)
          const month = entry.upload_date.substring(4, 6)
          const day = entry.upload_date.substring(6, 8)
          publishedAt = `${year}-${month}-${day}`
          publishedAtDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day))
        }

        // Filter by date if specified
        // If sinceDate is set but entry has no upload_date, exclude it (conservative).
        // Otherwise older videos can slip through and only be revealed later when
        // full metadata is extracted for each video.
        if (sinceDateObj && !publishedAtDate) {
          filteredOutMissingDate += 1
          continue
        }

        // Extra safety: date-only string comparison (YYYY-MM-DD) is stable.
        if (sinceDateStr && publishedAt && publishedAt < sinceDateStr) {
          filteredOut += 1
          continue
        }

        if (sinceDateObj && publishedAtDate && publishedAtDate < sinceDateObj) {
          filteredOut += 1
          continue
        }

        if (publishedAt) {
          if (!minPublishedAt || publishedAt < minPublishedAt) minPublishedAt = publishedAt
          if (!maxPublishedAt || publishedAt > maxPublishedAt) maxPublishedAt = publishedAt
        }

        videos.push({
          id: entry.id,
          title: entry.title,
          url: entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
          publishedAt,
          viewCount: entry.view_count ?? null,
          duration: entry.duration ?? null,
        })
      } catch {
        continue
      }
    }

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/52f648b0-5232-4d77-a7e9-77a4d95956d2',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'181fb7'},body:JSON.stringify({sessionId:'181fb7',runId:debugRunId,hypothesisId:'H3',location:'src/index.ts:530',message:'channel videos success',data:{totalEntries:lines.length,returned:videos.length,filteredOut,filteredOutMissingDate,minPublishedAt,maxPublishedAt,firstVideoId:videos[0]?.id ?? null,lastVideoId:videos.at(-1)?.id ?? null},timestamp:Date.now()})}).catch(()=>{})
    // #endregion

    return c.json({
      videos,
      meta: {
        requestedSinceDate: sinceDate ?? null,
        ytDlpDateafter: dateafter,
        maxVideos,
        totalEntries: lines.length,
        returned: videos.length,
        filteredOut,
        filteredOutMissingDate,
        minPublishedAt,
        maxPublishedAt,
      },
    })
  } catch (error) {
    const err = error as { message?: string; stderr?: string }
    const failureCategory = classifyYtDlpFailure(err.stderr || err.message)
    const stderrSnippet = summarizeDebugText(err.stderr)
    const messageSnippet = summarizeDebugText(err.message)
    const ytDlpVersion = await getYtDlpVersion()
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/52f648b0-5232-4d77-a7e9-77a4d95956d2',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'181fb7'},body:JSON.stringify({sessionId:'181fb7',runId:createDebugRunId('channel-videos-error'),hypothesisId:'H1',location:'src/index.ts:547',message:'channel videos failure',data:{failureCategory,stderrSnippet,messageSnippet,cookiesEnabled:getCookiesConfig().enabled,cookiesSource:cachedCookiesSource ?? getCookiesConfig().source,ytDlpVersion},timestamp:Date.now()})}).catch(()=>{})
    // #endregion
    console.error('[yt-dlp] Channel videos extraction failed:', err.stderr || err.message)
    return c.json(
      {
        error: 'Failed to extract channel videos',
        details: err.stderr || err.message,
        failureCategory,
        stderrSnippet,
        messageSnippet,
        request: {
          url,
          sinceDate: sinceDate ?? null,
          maxVideos,
        },
        ytDlp: {
          version: ytDlpVersion,
          cookiesEnabled: getCookiesConfig().enabled,
          cookiesSource: cachedCookiesSource ?? getCookiesConfig().source,
          verbose: process.env.YT_DLP_VERBOSE === '1',
        },
      },
      500
    )
  }
})

const port = parseInt(process.env.PORT || '3001')
console.log(`🚀 yt-dlp-api running on port ${port}`)

serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0',
})
