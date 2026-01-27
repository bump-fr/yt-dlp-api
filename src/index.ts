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

    return c.json({
      id: data.id,
      title: data.title,
      description: data.description || null,
      pinnedComment,
      channelId: data.channel_id,
      channelName: data.channel || data.uploader || 'Unknown',
      channelUrl: data.channel_url || data.uploader_url || `https://www.youtube.com/channel/${data.channel_id}`,
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
    const command = `yt-dlp --dump-json --skip-download --no-warnings --playlist-end 0 "${url}"`

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
    const command = `yt-dlp --flat-playlist --dump-json --no-warnings --playlist-end ${maxVideos} "${videosUrl}"`

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

    const sinceDateObj = sinceDate ? new Date(sinceDate) : null

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

    return c.json({ videos })
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
})
