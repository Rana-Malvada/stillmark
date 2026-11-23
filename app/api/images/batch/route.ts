import { withBrowseRequest } from '@/lib/browse-request'
import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, jsonBody, PRIVATE_NO_STORE } from '@/lib/http'
import { route } from '@/lib/route'
import { readablePreviewPaths } from '@/lib/media/preview-batch-query'
import { getPresignedUrls } from '@/lib/media/image-urls'
import { previewBatchResponse } from '@/lib/media/preview-batch-response'
import { PREVIEW_BATCH_LIMIT, previewPath } from '@/public/preview-batch.mjs'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
export const POST = withBrowseRequest(
  route({ errorHeaders: PRIVATE_NO_STORE }, async (req: Request) => {
    if (!flagOn('PREVIEW_BATCH_ENABLED')) throw new HttpError(404, 'Not found')
    await requireAuth()
    await requireSameOrigin()
    const { paths, cached = [] } = await jsonBody(req, 8192)
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > PREVIEW_BATCH_LIMIT ||
      !paths.every(previewPath) ||
      !Array.isArray(cached) ||
      cached.length > PREVIEW_BATCH_LIMIT ||
      !cached.every((path: unknown) => paths.includes(path))
    )
      throw new HttpError(400, 'Invalid preview batch')
    // Paths are selectors, never authority. Live photo + album RLS applies to this set.
    const allowed = await readablePreviewPaths(paths)
    const items = paths.map((path) => (allowed.has(path) ? path : null))
    const reusable = items.filter((path) => path !== null && cached.includes(path))
    return await previewBatchResponse(
      req,
      items,
      async (path) => (await getPresignedUrls([path])).get(path)!,
      {
        reusable,
        versions: [],
        signMany: getPresignedUrls,
      },
    )
  }),
)
