import { createHash } from 'node:crypto'
import { HttpError } from '../http'
import { PREVIEW_BATCH_LIMIT } from '@/public/preview-batch.mjs'

/** Client cache hints never grant access. Call only after live authorization resolves items. */
export function previewSelection(ids: number[], cached: unknown, items: (string | null)[]) {
  if (
    !Array.isArray(cached) ||
    cached.length > PREVIEW_BATCH_LIMIT ||
    !cached.every(
      (item) =>
        item &&
        ids.includes(Number(item.id)) &&
        typeof item.version === 'string' &&
        /^[0-9a-f]{64}$/.test(item.version),
    )
  )
    throw new HttpError(400, 'Invalid cached previews')
  const versions = items.map((path) =>
    path ? createHash('sha256').update(path).digest('hex') : null,
  )
  const reusable = items.filter(
    (path, i): path is string =>
      path !== null &&
      cached.some((item) => Number(item.id) === ids[i] && item.version === versions[i]),
  )
  return { versions, reusable }
}
