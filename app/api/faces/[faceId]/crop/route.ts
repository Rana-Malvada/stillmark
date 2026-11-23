import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAuth } from '@/lib/identity/auth'
import { apiError, HttpError, integer } from '@/lib/http'
import { fetchMedia } from '@/lib/media/media-fetch'
import { signCrop, visibleCrop } from '@/lib/people/face-crops'

export const dynamic = 'force-dynamic'

async function GETHandler(req: Request, { params }: { params: Promise<{ faceId: string }> }) {
  const timings: string[] = []
  async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
    const start = performance.now()
    try {
      return await run()
    } finally {
      timings.push(`${name};dur=${(performance.now() - start).toFixed(1)}`)
    }
  }
  try {
    await timed('session', () => requireAuth())
    const faceId = integer((await params).faceId, 'face', 1, Number.MAX_SAFE_INTEGER)
    const crop = await timed('visibility', () => visibleCrop(faceId))
    const url = await timed('signing', () => signCrop(crop))
    // Includes time to storage response headers, not the streamed body download.
    const upstream = await timed('storage_headers', () => fetchMedia(url, undefined, req.signal))
    if (upstream.status !== 200) {
      await upstream.body?.cancel()
      throw new HttpError(upstream.status === 404 ? 404 : 502, 'Face image unavailable')
    }
    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'image/webp',
        'Server-Timing': timings.join(', '),
        // Visibility depends on live sharing settings: never cache.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      },
    })
  } catch (error) {
    const response = apiError(error)
    response.headers.set('Cache-Control', 'private, no-store')
    response.headers.set('Server-Timing', timings.join(', '))
    return response
  }
}

export const GET = withDatabaseRequest(GETHandler)
