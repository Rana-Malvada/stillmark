import { traceUploadRequest, uploadRequestStep } from '@/lib/upload/upload-request-trace'
import { withUploadPoolAdmission } from '@/lib/upload/upload-routing-admission'
import { withUploadCompletionCapacity } from '@/lib/upload/upload-capacity'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireUploadUser } from '@/lib/albums/album-access'
import { trackUpload } from '@/lib/observability/activity-action'
import { requireSameOrigin } from '@/lib/identity/auth'
import { apiError, HttpError, jsonBody } from '@/lib/http'
import { enqueueUpload } from '@/lib/upload/upload-processing-jobs'
import { completeUpload } from '@/lib/upload/upload-sessions'
import { drainPhotoAiQueue } from '@/lib/photos/photo-ai-queue'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
async function POSTHandler(req: Request) {
  let id: unknown
  try {
    const caller = await uploadRequestStep('auth', () => requireUploadUser())
    await requireSameOrigin()
    const body = await jsonBody(req, 2 * 1024 * 1024)
    id = body.uploadId
    if (flagOn('UPLOAD_PROCESSING_QUEUE_ENABLED')) {
      // With the queue enabled every completion is queued. An inline completion would
      // hold the processing slots the queue worker shares and stall other uploads.
      if (body.queuedProcessing !== true)
        throw new HttpError(400, 'Queued processing is required for this upload')
      const result = await withUploadPoolAdmission(caller.username, () => enqueueUpload(body))
      return Response.json(result, { status: 'queued' in result ? 202 : 200 })
    }
    const result = await withUploadPoolAdmission(caller.username, () =>
      withUploadCompletionCapacity(() => completeUpload(caller.username, body)),
    )
    // Durable photo state is already committed; startup recovery also picks it up.
    if (process.env.UPLOAD_SERVICE_ONLY !== 'true')
      void drainPhotoAiQueue().catch((error) => console.error('[upload-ai]', error))
    trackUpload('completed', id)
    return Response.json(result)
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 429))
      trackUpload('failed', id, error instanceof HttpError ? error.status : 500)
    return apiError(error)
  }
}

export const POST = withDatabaseRequest(traceUploadRequest(POSTHandler))
