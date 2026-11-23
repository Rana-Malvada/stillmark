import { querySnowflakeStorage } from '@/lib/snowflake'
import { mediaStage } from '@/lib/snowflake/media-stage'
import { HttpError, integer, textValue } from '@/lib/http'
import { signedUrlCacheConfig } from '../snowflake/snowflake-capacity'
import { uploadTraceCount, uploadTraceGauge } from '../upload/upload-request-trace'
import {
  storageSigningBatch as signingBatch,
  StorageUrlSigner,
} from '../snowflake/storage-url-signer'
import { flagOn } from '../flags'

export { getImageProxyUrl } from './image-proxy-url'
export function validateStagePath(value: unknown): string {
  const path = textValue(value, 'path', 1024)
  if (
    !/^(originals|display|thumbnails)\//.test(path) ||
    path.split('/').some((s) => s === '..' || s === '.' || !s) ||
    path.includes('\\')
  )
    throw new HttpError(400, 'Invalid media path')
  return path
}
const cacheBudget = signedUrlCacheConfig()
const signer = new StorageUrlSigner(
  async (key, signal) => {
    const colon = key.indexOf(':')
    const seconds = Number(key.slice(0, colon))
    const path = key.slice(colon + 1)
    // Paths and expiration were validated before entering the shared signer.
    // This stage function rejects server-side path binds during compilation.
    const literal = path.replace(/'/g, "''")
    const expression = `GET_PRESIGNED_URL(${mediaStage(path)}, '${literal}', ${seconds})`
    const url = flagOn('MEDIA_SIGNING_BATCH_ENABLED')
      ? await signingBatch.sign(expression, signal)
      : (await querySnowflakeStorage(`SELECT ${expression} AS URL`))[0]?.URL
    if (typeof url !== 'string' || !url.startsWith('https://'))
      throw new Error('Unable to obtain media URL')
    return url
  },
  cacheBudget.maxEntries,
  cacheBudget.maxBytes,
  {
    observe: (event, cache) => {
      if (event === 'stored') {
        uploadTraceGauge('media-url-cache-size', cache.size)
        uploadTraceGauge('media-url-cache-bytes', cache.bytes)
      } else
        uploadTraceCount(event === 'coalesced' ? 'media-url-coalesced' : `media-url-cache-${event}`)
    },
  },
)
export async function getPresignedUrl(
  stagePath: string,
  expirationSeconds = 3600,
): Promise<string> {
  const path = validateStagePath(stagePath)
  const seconds = integer(expirationSeconds, 'expiration', 60, 7200)
  const key = `${seconds}:${path}`
  return signer.get(key, seconds)
}
export function invalidateMediaUrl(path: string) {
  for (const key of signer.keys()) if (key.endsWith(`:${path}`)) signer.invalidate(key)
}
export async function getPresignedUrls(paths: string[], seconds = 3600) {
  const result = new Map<string, string>()
  for (let i = 0; i < paths.length; i += 10)
    await Promise.all(
      paths
        .slice(i, i + 10)
        .map(async (path) => result.set(path, await getPresignedUrl(path, seconds))),
    )
  return result
}
