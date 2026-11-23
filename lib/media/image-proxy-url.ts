import { flagOn } from '../flags'

export function getImageProxyUrl(stagePath: string, expirationSeconds?: number): string {
  const params = new URLSearchParams({ path: stagePath })
  if (expirationSeconds) params.set('exp', String(expirationSeconds))
  if (flagOn('PREVIEW_BATCH_ENABLED') && stagePath.startsWith('thumbnails/'))
    params.set('batch', '1')
  return `/api/images?${params}`
}
