import { previewSelection } from '@/lib/media/preview-selection'
import { withBrowseRequest } from '@/lib/browse-request'
import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, integer, jsonBody, PRIVATE_NO_STORE } from '@/lib/http'
import { route } from '@/lib/route'
import { visibleFaceCropPaths } from '@/lib/media/preview-batch-query'
import { signCrop, validateCropPath } from '@/lib/people/face-crops'
import { previewBatchResponse } from '@/lib/media/preview-batch-response'
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
    const selected = ids.map((id) => integer(id, 'face', 1, Number.MAX_SAFE_INTEGER))
    const rows = await visibleFaceCropPaths(selected)
    const paths = new Map(
      rows.map((row) => [
        Number(row.face_id),
        row.crop_path ? validateCropPath(row.crop_path) : null,
      ]),
    )
    const items = selected.map((id) => paths.get(id) ?? null)
    return await previewBatchResponse(
      req,
      items,
      signCrop,
      previewSelection(selected, cached, items),
    )
  }),
)
