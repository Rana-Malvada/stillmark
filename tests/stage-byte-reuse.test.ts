import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

const mocks = vi.hoisted(() => ({ query: vi.fn(), reserve: vi.fn() }))
vi.mock('@/lib/snowflake', () => ({ querySnowflakeStorage: mocks.query }))
vi.mock('@/lib/postgres', () => ({ pgIndependent: mocks.reserve, pgQuery: vi.fn() }))
import { putFileToStage } from '@/lib/snowflake/stage-upload'
import { storageByteCache } from '@/lib/snowflake/storage-byte-cache'

beforeEach(() => {
  storageByteCache.clear()
  vi.resetAllMocks()
  mocks.query.mockResolvedValue([{ status: 'UPLOADED' }])
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'false')
})
afterEach(() => vi.unstubAllEnvs())
it('seeds same-process AI reuse only after confirmed durable display writes', async () => {
  const path = 'display/2400/1/reuse/image.jpg'
  mocks.query.mockResolvedValueOnce([{ status: 'ERROR' }])
  await expect(putFileToStage(Buffer.from('abc'), path)).rejects.toThrow('did not complete')
  expect(storageByteCache.size).toBe(0)
  storageByteCache.set(`ai:${path}`, Buffer.from('old prepared bytes'))
  await putFileToStage(Buffer.from('abc'), path)
  expect(storageByteCache.get(`ai:${path}`)).toBeUndefined()
  expect(storageByteCache.take(`display:${path}`)?.toString()).toBe('abc')
  expect(mocks.reserve).toHaveBeenCalledTimes(2)
})
it('upload-only processes do not copy display bytes that a separate AI process cannot use', async () => {
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'true')
  await putFileToStage(Buffer.from('abc'), 'display/2400/1/reuse/image.jpg')
  await putFileToStage(Buffer.from('abc'), 'originals/1/reuse/original.jpg')
  expect(mocks.query).toHaveBeenCalledTimes(2)
  expect(storageByteCache.bytes).toBe(0)
})
it('a file-backed replacement invalidates old local bytes rather than serving stale input', async () => {
  const path = 'display/2400/1/reuse/image.jpg'
  storageByteCache.set(`display:${path}`, Buffer.from('old'))
  storageByteCache.set(`ai:${path}`, Buffer.from('old prepared'))
  await putFileToStage(fileURLToPath(import.meta.url), path)
  expect(storageByteCache.size).toBe(0)
})
