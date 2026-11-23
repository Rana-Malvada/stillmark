import { traceUploadRequest, uploadRequestStep } from '@/lib/upload/upload-request-trace'
import { withUploadPoolAdmission } from '@/lib/upload/upload-routing-admission'
import { withUploadChunkCapacity } from '@/lib/upload/upload-capacity'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAlbumAccess, requireUploadUser } from '@/lib/albums/album-access'
import { trackUpload } from '@/lib/observability/activity-action'
import { requireSameOrigin } from '@/lib/identity/auth'
import { apiError, readBody } from '@/lib/http'
import { CHUNK_BYTES } from '@/lib/upload/upload-limits'
import { saveChunk } from '@/lib/upload/upload-sessions'

export const dynamic = 'force-dynamic'
async function POSTHandler(req: Request) {
  try {
    const caller = await uploadRequestStep('auth', () => requireUploadUser())
    await requireSameOrigin()
    return await withUploadPoolAdmission(caller.username, () =>
      withUploadChunkCapacity(
        async () => {
          const bytes = await readBody(req, CHUNK_BYTES + 64 * 1024)
          const form = await new Response(new Uint8Array(bytes), {
            headers: { 'content-type': req.headers.get('content-type') || '' },
          }).formData()
          const result = await saveChunk(caller.username, form)
          if (Number(form.get('chunkIndex')) === 0) trackUpload('started', form.get('uploadId'))
          return Response.json(result)
        },
        { signal: req.signal, waitMs: 10000 },
      ),
    )
  } catch (error) {
    return apiError(error)
  }
}
async function DELETEHandler(req: Request) {
  try {
    const caller = await uploadRequestStep('auth', () => requireUploadUser())
    await requireSameOrigin()
    return await withUploadPoolAdmission(caller.username, async () => {
      const { uploadId } = await import('@/lib/upload/upload-sessions')
      const { pgQuery, pgTransaction } = await import('@/lib/postgres')
      const id = uploadId(new URL(req.url).searchParams.get('uploadId'))
      await pgTransaction(async () => {
        await pgQuery(
          'SELECT upload_id FROM upload_processing_jobs WHERE upload_id=$1 AND owner=$2 FOR UPDATE',
          [id, caller.username],
        )
        await pgQuery(
          'DELETE FROM upload_sessions WHERE upload_id=$1 AND owner=$2 AND result IS NULL',
          [id, caller.username],
        )
      })
      return Response.json({ ok: true })
    })
  } catch (error) {
    return apiError(error)
  }
}
async function GETHandler(req: Request) {
  try {
    const caller = await uploadRequestStep('auth', () => requireUploadUser())
    return await withUploadPoolAdmission(caller.username, async () => {
      const { uploadId } = await import('@/lib/upload/upload-sessions')
      const { pgQueryOne, pgQuery } = await import('@/lib/postgres')
      const id = uploadId(new URL(req.url).searchParams.get('uploadId'))
      const session = await pgQueryOne(
        `SELECT result,total_chunks,metadata,EXISTS(SELECT 1 FROM upload_processing_jobs j WHERE j.upload_id=upload_sessions.upload_id AND j.state IN ('queued','processing')) AS queued FROM upload_sessions WHERE upload_id=$1 AND owner=$2 AND expires_at>NOW()`,
        [id, caller.username],
      )
      if (!session) return Response.json({ exists: false, chunks: [] })
      if (session.result)
        await requireAlbumAccess(
          Number((session.result as { eventId: number }).eventId),
          true,
          caller,
        )
      const chunks = await pgQuery<{ chunk_index: number; hash: string }>(
        'SELECT chunk_index,hash FROM upload_chunks WHERE upload_id=$1 ORDER BY chunk_index',
        [id],
      )
      const activeWrites = await pgQuery<{ chunk_index: number }>(
        'SELECT chunk_index FROM upload_chunk_writes WHERE upload_id=$1 AND lease_until>NOW()',
        [id],
      )
      return Response.json({
        activeChunks: activeWrites.map((c) => c.chunk_index),
        exists: true,
        result: session.result,
        queued: session.queued,
        metadata: session.metadata,
        totalChunks: session.total_chunks,
        chunks: chunks.map((c) => c.chunk_index),
        chunkHashes: Object.fromEntries(chunks.map((c) => [c.chunk_index, c.hash])),
      })
    })
  } catch (error) {
    return apiError(error)
  }
}

export const POST = withDatabaseRequest(traceUploadRequest(POSTHandler))
export const DELETE = withDatabaseRequest(DELETEHandler)
export const GET = withDatabaseRequest(GETHandler)
