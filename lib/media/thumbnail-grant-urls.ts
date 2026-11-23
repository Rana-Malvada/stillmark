import { getImageProxyUrl } from './image-urls'
import { getSecret, SecretType } from '../snowflake'
import { issueThumbnailGrants } from '../media-grant.mjs'
import { flagOn } from '../flags'
/** Call only with paths from a completed, authorized bounded page. Never caller-supplied paths. */
export async function thumbnailGrantUrls(req: Request, paths: (string | null)[]) {
  const urls = paths.map((path) => (path ? getImageProxyUrl(path) : null))
  // Batched previews reauthorize every delivery; do not attach reusable capabilities.
  if (flagOn('PREVIEW_BATCH_ENABLED') || !flagOn('MEDIA_GRANTS_ENABLED')) return urls
  const { gatewayAssertion } = await import('../identity/gateway-auth')
  const assertion = gatewayAssertion(req.headers)
  // Native Snowflake sessions continue through live authorization.
  if (!assertion) return urls
  const tokens = await issueThumbnailGrants(
    paths,
    assertion,
    assertion.aud,
    getSecret('MEDIA_GRANT_SIGNING', SecretType.GENERIC_STRING),
  )
  return urls.map((url, i) => (url && tokens[i] ? `${url}&grant=${tokens[i]}` : url))
}
