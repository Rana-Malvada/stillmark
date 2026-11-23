import { HttpError } from '@/lib/http'
/** Public identifiers only; never includes a client secret or a caller-controlled redirect. */
export function auth0LogoutUrl() {
  const domain = process.env.AUTH0_DOMAIN ?? ''
  const client = process.env.AUTH0_GALLERY_CLIENT_ID ?? ''
  if (
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.auth0\.com$/.test(domain) ||
    !/^[A-Za-z0-9_-]{10,100}$/.test(client)
  )
    throw new HttpError(503, 'Logout is not configured')
  let origin: URL
  try {
    origin = new URL(process.env.APP_ORIGIN ?? '')
  } catch {
    throw new HttpError(503, 'Logout return address is not configured')
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new HttpError(503, 'Invalid logout return address')
  const url = new URL(`https://${domain}/v2/logout`)
  url.searchParams.set('client_id', client)
  url.searchParams.set('returnTo', origin.origin + '/')
  return url.toString()
}
