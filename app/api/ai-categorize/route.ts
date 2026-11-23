import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireMainAdmin } from '@/lib/albums/album-access'
import { requireSameOrigin } from '@/lib/identity/auth'
import { integer, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { drainPhotoAiQueue, retryPhotoInference } from '@/lib/photos/photo-ai-queue'

export const dynamic = 'force-dynamic'
export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    await requireMainAdmin()
    await requireSameOrigin()
    const body = await jsonBody(req)
    if (body.retryPhotoId !== undefined) {
      const id = integer(body.retryPhotoId, 'retryPhotoId')
      await retryPhotoInference(id)
    }
    void drainPhotoAiQueue().catch((error) => console.error('[manual-ai]', error))
    return Response.json({ queued: true }, { status: 202 })
  }),
)
