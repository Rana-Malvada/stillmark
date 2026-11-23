import { traceUploadRequest, uploadRequestStep } from '@/lib/upload/upload-request-trace'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireUploadUser } from '@/lib/albums/album-access'
import { requireSameOrigin } from '@/lib/identity/auth'
import { apiError, HttpError, jsonBody } from '@/lib/http'
import { uploadId } from '@/lib/upload/upload-sessions'
import { uploadProcessingStatus } from '@/lib/upload/upload-processing-jobs'

export const dynamic = 'force-dynamic'
export const POST = withDatabaseRequest(
  traceUploadRequest(async (req: Request) => {
    try {
      const caller = await uploadRequestStep('auth', () => requireUploadUser())
      await requireSameOrigin()
      const body = await jsonBody(req, 8192)
      if (!Array.isArray(body.uploadIds) || body.uploadIds.length > 100)
        throw new HttpError(400, 'Expected up to 100 upload IDs')
      return Response.json({
        jobs: await uploadProcessingStatus(body.uploadIds.map(uploadId), caller.username),
      })
    } catch (error) {
      return apiError(error)
    }
  }),
)
