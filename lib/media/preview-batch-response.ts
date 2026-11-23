import { deployment } from '@/config/deployment.mjs'
import { fetchMedia } from './media-fetch'
import { PREVIEW_CONTENT_TYPE, previewBatchStream } from '@/public/preview-batch.mjs'
/** Paths come only from a completed live authorized lookup. Never accepts client authority. */
export async function previewBatchResponse(
  req: Request,
  items: (string | null)[],
  sign: (path: string) => Promise<string>,
  options: {
    reusable: string[]
    versions: (string | null)[]
    revalidate?: () => Promise<void>
    headers?: Record<string, string>
    signMany?: (paths: string[]) => Promise<Map<string, string>>
  } = { reusable: [], versions: [] },
) {
  const headers = {
    ...options.headers,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(options.versions.length ? { 'x-preview-versions': JSON.stringify(options.versions) } : {}),
  }
  if (
    !options.revalidate &&
    req.headers.get('x-photo-media-transfer') === 'preview-batch-v1' &&
    req.headers.get('sf-context-current-user') === deployment.GATEWAY_USER
  )
    return Response.json(
      { items, ...(options.reusable.length ? { reusable: options.reusable } : {}) },
      { headers: { ...headers, 'x-photo-media-transfer': 'preview-batch-v1' } },
    )
  const unique = [
    ...new Set(items.filter((p): p is string => p !== null && !options.reusable.includes(p))),
  ]
  const signed = options.signMany
    ? await options.signMany(unique)
    : new Map(await Promise.all(unique.map(async (path) => [path, await sign(path)] as const)))
  const stream = previewBatchStream(
    items,
    (path, signal) =>
      path
        ? options.reusable.includes(path)
          ? Promise.resolve(new Response(null, { status: 304 }))
          : fetchMedia(signed.get(path)!, undefined, signal)
        : Promise.resolve(null),
    AbortSignal.any([req.signal, AbortSignal.timeout(20000)]),
  )
  // Public shares recheck expiry/revocation after bounded storage work, before releasing bytes.
  const body = options.revalidate ? await new Response(stream).arrayBuffer() : stream
  await options.revalidate?.()
  return new Response(body, { headers: { ...headers, 'Content-Type': PREVIEW_CONTENT_TYPE } })
}
