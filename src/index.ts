import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bearerAuth } from 'hono/bearer-auth'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const app = new Hono()

// CORS for your Vercel domain
app.use('/*', cors())

// Simple bearer token auth
const API_TOKEN = process.env.YT_DLP_API_TOKEN || 'dev-token'
app.use('/api/*', bearerAuth({ token: API_TOKEN }))

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'yt-dlp-api' }))

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
    const command = `yt-dlp --dump-json --skip-download --no-warnings --write-comments --extractor-args "youtube:comment_sort=top;max_comments=5" "${url}"`

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
    return c.json({ error: 'Failed to extract video metadata', details: err.stderr || err.message }, 500)
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
    // Use --playlist-items 1 to get just the first video and extract channel info
    const command = `yt-dlp --dump-json --skip-download --no-warnings --playlist-items 1 "${url}"`

    const { stdout } = await execAsync(command, {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 30000,
    })

    const data = JSON.parse(stdout)

    return c.json({
      id: data.channel_id || data.id,
      name: data.channel || data.uploader || data.title || 'Unknown',
      url: data.channel_url || data.uploader_url || url,
      description: data.description || null,
      subscriberCount: data.channel_follower_count ?? null,
      videoCount: data.playlist_count ?? null,
    })
  } catch (error) {
    const err = error as { message?: string; stderr?: string }
    console.error('[yt-dlp] Channel extraction failed:', err.stderr || err.message)
    return c.json({ error: 'Failed to extract channel metadata', details: err.stderr || err.message }, 500)
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
    const videosUrl = url.includes('/videos') ? url : `${url}/videos`
    const dateafter = sinceDate ? normalizeSinceDateForYtDlpDateafter(sinceDate) : null
    const dateafterFlag = dateafter ? ` --dateafter "${dateafter}"` : ''
    // Note: `--flat-playlist` is fast but may omit `upload_date` unless we enable it.
    // We enable youtubetab:approximate_date so entries include `upload_date`, allowing
    // both yt-dlp-side filtering (--dateafter) and JS fallback filtering to work.
    const extractorArgs = ` --extractor-args "youtubetab:approximate_date"`
    const command = `yt-dlp --flat-playlist --dump-json --no-warnings --playlist-end ${maxVideos}${extractorArgs}${dateafterFlag} "${videosUrl}"`

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
        if (sinceDateObj && publishedAtDate && publishedAtDate < sinceDateObj) {
          filteredOut += 1
          continue
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

    return c.json({
      videos,
      meta: {
        requestedSinceDate: sinceDate ?? null,
        ytDlpDateafter: dateafter,
        maxVideos,
        totalEntries: lines.length,
        returned: videos.length,
        filteredOut,
      },
    })
  } catch (error) {
    const err = error as { message?: string; stderr?: string }
    console.error('[yt-dlp] Channel videos extraction failed:', err.stderr || err.message)
    return c.json({ error: 'Failed to extract channel videos', details: err.stderr || err.message }, 500)
  }
})

const port = parseInt(process.env.PORT || '3001')
console.log(`🚀 yt-dlp-api running on port ${port}`)

serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0',
})
