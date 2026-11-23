import {
  facePreviewPath,
  PREVIEW_BATCH_LIMIT,
  PREVIEW_CONTENT_TYPE,
  previewBatchStream,
  previewPath,
} from '../public/preview-batch.mjs'
import { publicStorageUrls } from './media-delivery.mjs'
import { observePreviewBatch } from './preview-batch-diagnostics.mjs'
/**
 * Only called with a successful manifest from the authenticated fixed app origin.
 * @param {Request} request
 * @param {Response} manifest
 * @param {Env} env
 * @param {Fetch} [fetcher]
 */
export async function deliverPreviewBatch(request, manifest, env, fetcher = fetch) {
  const { items, reusable = [] } = await manifest.json()
  if (
    !Array.isArray(reusable) ||
    reusable.length > PREVIEW_BATCH_LIMIT ||
    !Array.isArray(items) ||
    !items.length ||
    items.length > PREVIEW_BATCH_LIMIT ||
    !items.every(
      (path) =>
        path === null ||
        (new URL(request.url).pathname === '/api/faces/batch'
          ? facePreviewPath(path)
          : previewPath(path)),
    )
  )
    throw Error('Invalid preview manifest')
  if (!reusable.every((path) => path !== null && items.includes(path)))
    throw Error('Invalid reusable previews')
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)])
  const signingStarted = env.GATEWAY_DIAGNOSTICS === 'enabled' ? Date.now() : 0
  const urls = await publicStorageUrls(
    items.filter((path) => path && !reusable.includes(path)),
    env,
    fetcher,
    signal,
  )
  return new Response(
    previewBatchStream(
      items,
      (path, signal) =>
        path
          ? reusable.includes(path)
            ? Promise.resolve(new Response(null, { status: 304 }))
            : // Signed above for every item that is not reused.
              fetcher(/** @type {string} */ (urls.get(path)), { redirect: 'manual', signal })
          : Promise.resolve(null),
      signal,
      observePreviewBatch(env, {
        signingMs: signingStarted ? Date.now() - signingStarted : 0,
        count: items.length,
        reused: reusable.length,
      }),
    ),
    {
      headers: {
        'Content-Type': PREVIEW_CONTENT_TYPE,
        ...(manifest.headers.has('x-preview-versions')
          ? {
              'x-preview-versions': /** @type {string} */ (
                manifest.headers.get('x-preview-versions')
              ),
            }
          : {}),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    },
  )
}
