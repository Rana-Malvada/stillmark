import { withPublicRequest } from '@/lib/public-request'
import { withPublicDatabase } from '@/lib/database/database-context'
import { publicAlbum, shareHeaders, tokenHash } from '@/lib/albums/public-albums'
import { listPublicAlbumThumbnails } from '@/lib/photos/public-photos'
import { HttpError, integer, jsonBody } from '@/lib/http'
import { getPresignedUrl } from '@/lib/media/image-urls'
import { previewBatchResponse } from '@/lib/media/preview-batch-response'
import { previewSelection } from '@/lib/media/preview-selection'
import { previewPath } from '@/public/preview-batch.mjs'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
async function handler(req: Request, context: { params: Promise<{ token: string }> }) {
  try {
    if (!flagOn('PREVIEW_BATCH_ENABLED')) throw new HttpError(404, 'Not found')
    const { token } = await context.params
    return await withPublicDatabase(
      tokenHash(token),
      async () => {
        const link = await publicAlbum(token)
        const { ids, cached = [] } = await jsonBody(req, 4096)
        if (!Array.isArray(ids) || !ids.length || ids.length > 8)
          throw new HttpError(400, 'Invalid preview batch')
        const selected = ids.map((id) => integer(id, 'photo', 1, 2147483647))
        const rows = await listPublicAlbumThumbnails(link.event_id, selected)
        const paths = new Map(
          rows
            .filter(
              (row) =>
                (!link.photo_ids || link.photo_ids.includes(Number(row.photo_id))) &&
                previewPath(row.thumbnail_stage_path),
            )
            .map((row) => [Number(row.photo_id), row.thumbnail_stage_path]),
        )
        const items = selected.map((id) => paths.get(id) ?? null)
        return await previewBatchResponse(req, items, getPresignedUrl, {
          ...previewSelection(selected, cached, items),
          headers: shareHeaders,
          revalidate: async () => {
            const current = await publicAlbum(token)
            if (
              current.event_id !== link.event_id ||
              (current.photo_ids &&
                items.some((path, i) => path && !current.photo_ids!.includes(selected[i])))
            )
              throw new HttpError(404, 'This link is unavailable or has expired.')
          },
        })
      },
      req.signal,
    )
  } catch (error) {
    return new Response(error instanceof HttpError ? error.message : 'Previews unavailable', {
      status: error instanceof HttpError ? error.status : 500,
      headers: shareHeaders,
    })
  }
}
export const POST = withPublicRequest(handler)
