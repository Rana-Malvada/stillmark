import { deployment } from '../../config/deployment.mjs'
/** Metadata only; callers must finish their live user/share and album checks first. */
export function mediaHandoff(
  req: Request,
  path: string,
  type: string,
  revalidateThumbnail = false,
) {
  if (
    req.headers.get('x-photo-media-transfer') !== 'public-sql-v2' ||
    req.headers.get('sf-context-current-user') !== deployment.GATEWAY_USER
  )
    return null
  return Response.json(
    { path, type, ...(revalidateThumbnail ? { revalidateThumbnail: true } : {}) },
    {
      headers: { 'x-photo-media-transfer': 'public-sql-v2', 'Cache-Control': 'private, no-store' },
    },
  )
}
