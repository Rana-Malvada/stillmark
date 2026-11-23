import { createHash, randomUUID } from 'node:crypto'
import { putFileToStage } from '../snowflake/stage-upload'
import { storageUrlSigner } from '../snowflake/storage-url-signer'
import { STAGE } from '../snowflake/storage-constants'
import { CHUNK_BYTES } from './upload-limits'
import { storageByteCache } from '../snowflake/storage-byte-cache'
import { flagNotOff } from '../flags'

export async function storeUploadChunk(id: string, index: number, data: Buffer): Promise<string> {
  if (
    !/^[a-f0-9-]{36}$/i.test(id) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= 512 ||
    data.length < 1 ||
    data.length > CHUNK_BYTES
  )
    throw Error('Invalid upload chunk')
  // Unique write attempts prevent cleanup/retry races with expired sessions.
  const path = `upload-chunks/${id}/${index}-${randomUUID()}.bin`
  await putFileToStage(data, path)
  storageByteCache.set(path, data)
  return path
}
function chunkExpression(path: string) {
  if (!/^upload-chunks\/[a-f0-9-]{36}\/\d+-[a-f0-9-]{36}\.bin$/i.test(path))
    throw Error('Invalid stored upload chunk')
  return `GET_PRESIGNED_URL(${STAGE}, '${path}', 300)`
}
/** Only prefetch URL metadata; file bytes are still read one chunk at a time. */
export async function prepareUploadChunkUrls(paths: string[]) {
  if (paths.length > 16) throw Error('Chunk signing window is too large')
  const expressions = paths.map(chunkExpression)
  await Promise.all(
    expressions.map((expression, i) =>
      storageByteCache.has(paths[i]) && flagNotOff('STORAGE_BYTE_REUSE_ENABLED')
        ? undefined
        : storageUrlSigner.get(expression, 300),
    ),
  )
}
export async function readUploadChunk(path: string, size: number, hash: string): Promise<Buffer> {
  if (
    !/^upload-chunks\/[a-f0-9-]{36}\/\d+-[a-f0-9-]{36}\.bin$/i.test(path) ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > CHUNK_BYTES
  )
    throw Error('Invalid stored upload chunk')
  const expression = chunkExpression(path)
  const cached = storageByteCache.take(path)
  if (cached) {
    if (cached.length !== size || createHash('sha256').update(cached).digest('hex') !== hash)
      throw Error('Chunk integrity check failed')
    return cached
  }
  const url = await storageUrlSigner.get(expression, 300)
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) })
  if (!response.ok || !response.body) {
    if (response.status === 401 || response.status === 403) storageUrlSigner.invalidate(expression)
    await response.body?.cancel()
    throw Error('Upload chunk unavailable; retry completion')
  }
  const reader = response.body.getReader()
  const data = Buffer.allocUnsafe(size)
  let offset = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.length > size) throw Error('Chunk size mismatch')
      data.set(value, offset)
      offset += value.length
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (offset !== size || createHash('sha256').update(data).digest('hex') !== hash)
    throw Error('Chunk integrity check failed')
  return data
}
