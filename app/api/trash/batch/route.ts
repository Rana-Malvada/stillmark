import { previewSelection } from '@/lib/media/preview-selection'
import { withBrowseRequest } from '@/lib/browse-request'
import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, integer, jsonBody, PRIVATE_NO_STORE } from '@/lib/http'
import { route } from '@/lib/route'
import { listTrashThumbnailPaths } from '@/lib/photos/photo-trash'
import { albumCaller } from '@/lib/albums/album-access'
import { getPresignedUrl } from '@/lib/media/image-urls'
import { previewBatchResponse } from '@/lib/media/preview-batch-response'
import { previewPath } from '@/public/preview-batch.mjs'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
export const POST = withBrowseRequest(
  route({ errorHeaders: PRIVATE_NO_STORE }, async (req: Request) => {
    if (!flagOn('PREVIEW_BATCH_ENABLED')) throw new HttpError(404, 'Not found')
    await requireAuth()
    await requireSameOrigin()
    const { ids, cached = [] } = await jsonBody(req, 4096)
    if (!Array.isArray(ids) || !ids.length || ids.length > 8)
      throw new HttpError(400, 'Invalid preview batch')
    const selected = ids.map((id) => integer(id, 'photo'))
    const caller = await albumCaller()
    const rows = await listTrashThumbnailPaths(selected, caller)
    const paths = new Map(
      rows.map((row) => [Number(row.photo_id), previewPath(row.path) ? row.path : null]),
    )
    const items = selected.map((id) => paths.get(id) ?? null)
    return await previewBatchResponse(
      req,
      items,
      getPresignedUrl,
      previewSelection(selected, cached, items),
    )
  }),
)
