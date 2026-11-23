import { beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const s = vi.hoisted(() => ({ query: vi.fn(), put: vi.fn() }))
vi.mock('@/lib/snowflake', () => ({ querySnowflakeStorage: s.query, querySnowflake: s.query }))
vi.mock('@/lib/snowflake/stage-upload', () => ({ putFileToStage: s.put }))
import {
  prepareUploadChunkUrls,
  readUploadChunk,
  storeUploadChunk,
} from '@/lib/upload/upload-chunk-stage'

const path =
  'upload-chunks/11111111-1111-4111-8111-111111111111/0-22222222-2222-4222-8222-222222222222.bin'
import { storageUrlSigner } from '@/lib/snowflake/storage-url-signer'
import { storageByteCache } from '@/lib/snowflake/storage-byte-cache'
import { STAGE } from '@/lib/snowflake/storage-constants'

const hash = createHash('sha256').update('abc').digest('hex')
beforeEach(() => {
  storageByteCache.clear()
  storageUrlSigner.invalidate(`GET_PRESIGNED_URL(${STAGE}, '${path}', 300)`)
  vi.resetAllMocks()
  s.query.mockResolvedValue([{ URL0: 'https://storage.example/file' }])
})
it('unique paths isolate write retries and rejects invalid identifiers', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  expect(await storeUploadChunk(id, 0, Buffer.from('abc'))).not.toBe(
    await storeUploadChunk(id, 0, Buffer.from('abc')),
  )
  await expect(storeUploadChunk('../escape', 0, Buffer.from('a'))).rejects.toThrow()
})
it('verifies downloaded bytes and rejects corruption, truncation, overflow and missing objects', async () => {
  for (const data of ['ab', 'abcd', 'xyz']) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(data)))
    await expect(readUploadChunk(path, 3, hash)).rejects.toThrow()
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('abc')))
  expect(await readUploadChunk(path, 3, hash)).toEqual(Buffer.from('abc'))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
  await expect(readUploadChunk(path, 3, hash)).rejects.toThrow('unavailable')
})
it('refuses paths outside the private chunk prefix', async () => {
  await expect(readUploadChunk('originals/private.jpg', 3, hash)).rejects.toThrow()
  expect(s.query).not.toHaveBeenCalled()
})

it('signs a window together and reuses URLs for sequential downloads and retries', async () => {
  const second = path.replace('/0-', '/1-')
  s.query.mockResolvedValue([
    { URL0: 'https://storage.example/one', URL1: 'https://storage.example/two' },
  ])
  await prepareUploadChunkUrls([path, second])
  expect(s.query).toHaveBeenCalledTimes(1)
  expect(s.query.mock.calls[0][0]).toContain('AS URL1')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response('abc')),
  )
  for (const p of [path, second, path])
    expect(await readUploadChunk(p, 3, hash)).toEqual(Buffer.from('abc'))
  expect(s.query).toHaveBeenCalledTimes(1)
})
it('invalidates a rejected signature before the next retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))
  await expect(readUploadChunk(path, 3, hash)).rejects.toThrow('unavailable')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('abc')))
  await readUploadChunk(path, 3, hash)
  expect(s.query).toHaveBeenCalledTimes(2)
})
it('validates the whole bounded window before signing', async () => {
  await expect(prepareUploadChunkUrls(Array(17).fill(path))).rejects.toThrow('too large')
  await expect(prepareUploadChunkUrls([path, 'originals/private.jpg'])).rejects.toThrow('Invalid')
  expect(s.query).not.toHaveBeenCalled()
})

it('reuses durably written chunks without signing or downloading, checking integrity again', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const data = Buffer.from('abc')
  const p = await storeUploadChunk('11111111-1111-4111-8111-111111111111', 0, data)
  data.fill(0)
  await prepareUploadChunkUrls([p])
  expect(await readUploadChunk(p, 3, hash)).toEqual(Buffer.from('abc'))
  expect(s.put).toHaveBeenCalledTimes(1)
  expect(s.query).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  storageByteCache.set(p, Buffer.from('bad'))
  await expect(readUploadChunk(p, 3, hash)).rejects.toThrow('integrity')
})
it('does not cache failed writes and recovers from cache loss or another worker via storage', async () => {
  s.put.mockRejectedValueOnce(Error('write failed'))
  await expect(
    storeUploadChunk('11111111-1111-4111-8111-111111111111', 0, Buffer.from('abc')),
  ).rejects.toThrow('write failed')
  expect(storageByteCache.size).toBe(0)
  const p = await storeUploadChunk('11111111-1111-4111-8111-111111111111', 0, Buffer.from('abc'))
  await prepareUploadChunkUrls([p])
  storageByteCache.clear() // restart/eviction after prefetch must still fall back
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('abc')))
  expect(await readUploadChunk(p, 3, hash)).toEqual(Buffer.from('abc'))
  expect(s.query).toHaveBeenCalledTimes(1)
})
