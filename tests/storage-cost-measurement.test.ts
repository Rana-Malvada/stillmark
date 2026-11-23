import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => ({ put: vi.fn(), query: vi.fn() }))
vi.mock('@/lib/snowflake/stage-upload', () => ({ putFileToStage: mocks.put }))
vi.mock('@/lib/snowflake', () => ({ querySnowflakeStorage: mocks.query }))
import {
  prepareUploadChunkUrls,
  readUploadChunk,
  storeUploadChunk,
} from '@/lib/upload/upload-chunk-stage'
import { storageByteCache } from '@/lib/snowflake/storage-byte-cache'

afterEach(() => {
  storageByteCache.clear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('measures same-worker savings and bounded overflow for 1,000 distinct upload sessions', async () => {
  const data = Buffer.alloc(64 * 1024, 17)
  const hash = createHash('sha256').update(data).digest('hex')
  const results = []
  for (const burst of [false, true])
    for (const reuse of [false, true]) {
      vi.stubEnv('STORAGE_BYTE_REUSE_ENABLED', String(reuse))
      storageByteCache.clear()
      mocks.put.mockReset().mockResolvedValue(undefined)
      mocks.query
        .mockReset()
        .mockImplementation(async (sql: string) => [
          Object.fromEntries(
            [...sql.matchAll(/AS (URL\d+)/g)].map((m) => [m[1], 'https://storage.example/chunk']),
          ),
        ])
      const fetch = vi.fn(async () => new Response(new Uint8Array(data)))
      vi.stubGlobal('fetch', fetch)
      const count = burst ? 1000 : 100
      const started = performance.now()
      const upload = (i: number) =>
        storeUploadChunk(`11111111-1111-4111-8111-${String(i).padStart(12, '0')}`, 0, data)
      let peak = 0
      if (burst) {
        const paths = await Promise.all(Array.from({ length: count }, (_, i) => upload(i)))
        peak = storageByteCache.bytes
        for (let i = 0; i < count; i += 16) {
          const window = paths.slice(i, i + 16)
          await prepareUploadChunkUrls(window)
          for (const p of window)
            expect((await readUploadChunk(p, data.length, hash)).equals(data)).toBe(true)
        }
      } else
        for (let i = 0; i < count; i++) {
          const path = await upload(i)
          peak = Math.max(peak, storageByteCache.bytes)
          await prepareUploadChunkUrls([path])
          expect((await readUploadChunk(path, data.length, hash)).equals(data)).toBe(true)
        }
      expect(mocks.put).toHaveBeenCalledTimes(count) // acknowledgments remain durable
      expect(peak).toBeLessThanOrEqual(32 * 1024 ** 2)
      const reads = fetch.mock.calls.length
      expect(reads).toBe(reuse ? (burst ? 872 : 0) : count)
      results.push({
        burst,
        reuse,
        chunks: count,
        durableWrites: mocks.put.mock.calls.length,
        signingStatements: mocks.query.mock.calls.length,
        storageReads: reads,
        peakCacheBytes: peak,
        fixtureMs: Math.round(performance.now() - started),
      })
    }
  console.info(
    'Storage cost fixture (mock storage; not production latency or billed credits):',
    JSON.stringify(results),
  )
}, 30000)
