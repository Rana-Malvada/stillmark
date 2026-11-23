// Versioned, session-bound thumbnail capabilities. No original/download/share authority.
export const MEDIA_GRANT_TTL_SECONDS = 60
export function immutableThumbnail(path) {
  return (
    typeof path === 'string' &&
    /^thumbnails\/400\/[1-9][0-9]*\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/image\.jpg$/.test(
      path,
    )
  )
}
const encode = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
const decode = (text) =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
async function signingKey(secret, usage) {
  if (!/^[a-f0-9]{64}$/.test(secret ?? '')) throw Error('Media grant key unavailable')
  return crypto.subtle.importKey(
    'raw',
    Uint8Array.from(secret.match(/../g), (x) => parseInt(x, 16)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}
export async function issueThumbnailGrants(
  paths,
  session,
  audience,
  secret,
  now = Math.floor(Date.now() / 1000),
) {
  if (paths.length > 100 || !session?.sid || !session?.sub || !Number.isInteger(now))
    throw Error('Invalid media grant batch')
  const key = await signingKey(secret, 'sign')
  return Promise.all(
    paths.map(async (path) => {
      if (!immutableThumbnail(path)) return null
      const body = encode(
        new TextEncoder().encode(
          JSON.stringify({
            v: 1,
            path,
            variant: 'thumbnail',
            sid: session.sid,
            sub: session.sub,
            aud: audience,
            iat: now,
            exp: now + MEDIA_GRANT_TTL_SECONDS,
          }),
        ),
      )
      return (
        body +
        '.' +
        encode(
          new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))),
        )
      )
    }),
  )
}
// Expiration is distinct from invalid authority: an expired URL can take the live ACL path.
export async function verifyThumbnailGrant(
  token,
  path,
  session,
  audience,
  secret,
  now = Math.floor(Date.now() / 1000),
) {
  if (typeof token !== 'string' || token.length > 2048 || !immutableThumbnail(path))
    throw Error('Invalid media grant')
  const parts = token.split('.')
  if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
    throw Error('Invalid media grant')
  const key = await signingKey(secret, 'verify')
  if (
    !(await crypto.subtle.verify('HMAC', key, decode(parts[1]), new TextEncoder().encode(parts[0])))
  )
    throw Error('Invalid media grant')
  const g = JSON.parse(new TextDecoder().decode(decode(parts[0])))
  if (
    g.v !== 1 ||
    g.variant !== 'thumbnail' ||
    g.path !== path ||
    g.sid !== session?.sid ||
    g.sub !== session?.auth0Subject ||
    g.aud !== audience ||
    !Number.isInteger(g.iat) ||
    !Number.isInteger(g.exp) ||
    g.iat > now + 5 ||
    g.exp <= g.iat ||
    g.exp - g.iat > MEDIA_GRANT_TTL_SECONDS
  )
    throw Error('Invalid media grant')
  return g.exp > now ? g : null
}
