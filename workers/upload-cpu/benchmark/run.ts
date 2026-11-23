/** Finite diagnostic job. Runs real photo processing on the upload pool, never publishes media. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { databaseContext } from '../../../lib/database/database-context'
import { closePool, pgQuery, pgQueryOne, pgTransaction } from '../../../lib/postgres'
import { querySnowflakeStorage } from '../../../lib/snowflake'
import { STAGE } from '../../../lib/snowflake/storage-constants'
import { readUploadChunk, storeUploadChunk } from '../../../lib/upload/upload-chunk-stage'
import { ingestUpload } from '../../../lib/upload/ingest-upload'
import { profileUpload, uploadStep } from '../../../lib/upload/upload-profile'
import { withUploadCompletionCapacity } from '../../../lib/upload/upload-capacity'
import { CHUNK_BYTES } from '../../../lib/upload/upload-limits'

const owner = process.env.BENCH_OWNER!
const eventId = Number(process.env.BENCH_EVENT_ID)
if (!owner || !Number.isSafeInteger(eventId) || eventId < 1)
  throw Error('Explicit benchmark owner and album required')
const caller = { username: owner, role: 'admin' as const, mainAdmin: true, canManagePersonal: true }
const identity = Promise.resolve({
  username: owner,
  mainAdmin: true,
  adminRead: true,
  adminWrite: true,
  canWrite: true,
  accessManager: false,
})
const chunkIds: string[] = []
let fixtureValidated = false
const emit = (data: unknown) => console.log('UPLOAD_BENCH ' + JSON.stringify(data))
const resourceFile = (...paths: string[]) => {
  for (const path of paths) {
    try {
      return readFileSync(path, 'utf8').trim()
    } catch {}
  }
  return null
}
const cgroup = () => {
  try {
    return Object.fromEntries(
      (
        resourceFile(
          '/sys/fs/cgroup/cpu.stat',
          '/sys/fs/cgroup/cpu/cpu.stat',
          '/sys/fs/cgroup/cpu,cpuacct/cpu.stat',
        ) ?? ''
      )
        .trim()
        .split('\n')
        .map((l) => {
          const [k, v] = l.split(' ')
          return [k, Number(v)]
        }),
    )
  } catch {
    return {} as Record<string, number>
  }
}
const rolledBack = new Error('benchmark publication rolled back')
async function run() {
  const fixture = await pgQueryOne<{ event_name: string }>(
    'SELECT event_name FROM events WHERE event_id=$1 AND owner_username=$2',
    [eventId, owner],
  )
  if (!fixture?.event_name.startsWith('__upload_benchmark_'))
    throw Error('Not an isolated benchmark album')
  const existingPhotos = await pgQueryOne<{ n: number }>(
    'SELECT count(*)::int n FROM photos WHERE event_id=$1',
    [eventId],
  )
  if (existingPhotos?.n !== 0) throw Error('Benchmark album must be empty')
  fixtureValidated = true
  const active = await pgQueryOne<{ n: number }>('SELECT count(*)::int n FROM upload_pool_requests')
  if (active?.n) throw Error('Upload worker still has active requests')
  // Fixed sample for every trial, mixing 3–10 MB JPEGs. Originals remain in Snowflake.
  const sources = await pgQuery<{
    original_stage_path: string
    file_size_bytes: string
    file_hash: string
  }>(
    `WITH ranked AS (
    SELECT original_stage_path,file_size_bytes,file_hash,
    row_number() OVER(PARTITION BY width_bucket(file_size_bytes,3000000,10000001,3) ORDER BY photo_id DESC) n
    FROM photos p JOIN events e USING(event_id) WHERE media_type='photo' AND lower(file_extension) IN ('jpg','jpeg')
    AND file_size_bytes BETWEEN 3000000 AND 10000000 AND e.owner_username=$1)
    SELECT original_stage_path,file_size_bytes,file_hash FROM ranked WHERE n<=4 ORDER BY file_size_bytes`,
    [owner],
  )
  if (sources.length < 6) throw Error('Insufficient representative JPEGs')
  const samples: { bytes: number; chunks: { path: string; bytes: number; hash: string }[] }[] = []
  for (const src of sources) {
    const rows = await querySnowflakeStorage(
      `SELECT GET_PRESIGNED_URL(${STAGE}, '${src.original_stage_path.replaceAll("'", "''")}', 300) AS URL`,
    )
    const response = await fetch(rows[0].URL ?? rows[0].url, { signal: AbortSignal.timeout(60000) })
    if (!response.ok) throw Error('Sample unavailable')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (
      bytes.length !== Number(src.file_size_bytes) ||
      createHash('sha256').update(bytes).digest('hex') !== src.file_hash
    )
      throw Error('Sample integrity mismatch')
    const id = randomUUID()
    chunkIds.push(id)
    const chunks = []
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const data = bytes.subarray(offset, offset + CHUNK_BYTES)
      chunks.push({
        path: await storeUploadChunk(id, chunks.length, data),
        bytes: data.length,
        hash: createHash('sha256').update(data).digest('hex'),
      })
    }
    samples.push({ bytes: bytes.length, chunks })
  }
  emit({
    type: 'sample',
    count: samples.length,
    bytes: samples.map((s) => s.bytes),
    cpuMax: resourceFile(
      '/sys/fs/cgroup/cpu.max',
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us',
      '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us',
    ),
    memoryMax: resourceFile(
      '/sys/fs/cgroup/memory.max',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    ),
  })
  async function one(index: number) {
    return profileUpload(() =>
      withUploadCompletionCapacity(async () => {
        const sample = samples[index]
        const buffer = await uploadStep('readChunks', async () => {
          const result = Buffer.allocUnsafe(sample.bytes)
          let offset = 0
          for (const chunk of sample.chunks) {
            const bytes = await readUploadChunk(chunk.path, chunk.bytes, chunk.hash)
            result.set(bytes, offset)
            offset += bytes.length
          }
          return result
        })
        await ingestUpload(
          buffer,
          { eventId, fileName: `bench-${index}.jpg`, folderName: 'benchmark' },
          undefined,
          caller,
          async (fn) => {
            let result: any
            try {
              await uploadStep('publicationRollback', () =>
                pgTransaction(async () => {
                  result = await fn()
                  throw rolledBack
                }),
              )
            } catch (error) {
              if (error !== rolledBack) throw error
            }
            return result
          },
        )
      }),
    )
  }
  process.env.UPLOAD_COMPLETIONS_PER_INSTANCE = '1'
  await one(0) // Warm connections and native image libraries before compared trials.
  for (const [trial, concurrency] of [1, 2, 4, 4, 2, 1].entries()) {
    process.env.UPLOAD_COMPLETIONS_PER_INSTANCE = String(concurrency)
    const before = cgroup()
    const cpu = process.cpuUsage()
    const started = performance.now()
    const delay = monitorEventLoopDelay({ resolution: 20 })
    delay.enable()
    let peakRss = process.memoryUsage().rss
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
    }, 25)
    let next = 0
    const results: any[] = []
    try {
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < samples.length) {
            const index = next++
            const measured = await one(index)
            results.push({ index, bytes: samples[index].bytes, ...measured })
          }
        }),
      )
    } finally {
      clearInterval(sampler)
      delay.disable()
    }
    const after = cgroup()
    const elapsedMs = performance.now() - started
    emit({
      type: 'trial',
      trial,
      concurrency,
      elapsedMs,
      filesPerMinute: (results.length * 60000) / elapsedMs,
      peakRss,
      eventLoopP99Ms: delay.percentile(99) / 1e6,
      cpu: process.cpuUsage(cpu),
      cgroupDelta: Object.fromEntries(
        Object.keys(after).map((k) => [k, after[k] - (before[k] ?? 0)]),
      ),
      results,
    })
  }
}
async function cleanup() {
  // Never delete a prefix merely because BENCH_EVENT_ID was supplied.
  if (!fixtureValidated) return
  const published = await pgQueryOne<{ n: number }>(
    'SELECT count(*)::int n FROM photos WHERE event_id=$1',
    [eventId],
  )
  if (published?.n !== 0) throw Error('Cleanup blocked: album has published photos')
  for (const prefix of [
    `originals/${eventId}/`,
    `display/2400/${eventId}/`,
    `thumbnails/400/${eventId}/`,
  ]) {
    await querySnowflakeStorage(`REMOVE '${STAGE}/${prefix}' PATTERN='.*'`)
    await pgQuery('DELETE FROM stage_cleanup WHERE path LIKE $1', [prefix + '%'])
  }
  if (chunkIds.length) {
    const pattern = `.*upload-chunks/(${chunkIds.join('|')})/.*`
    await querySnowflakeStorage(`REMOVE '${STAGE}/upload-chunks/' PATTERN='${pattern}'`)
    await pgQuery(
      "DELETE FROM stage_cleanup WHERE split_part(path,'/',2)=ANY($1::text[]) AND path LIKE 'upload-chunks/%'",
      [chunkIds],
    )
  }
  emit({ type: 'cleanup', ok: true })
}
databaseContext
  .run({ kind: 'request', identity }, async () => {
    try {
      await run()
    } catch (error) {
      emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      process.exitCode = 1
    } finally {
      try {
        await cleanup()
      } catch (error) {
        emit({ type: 'cleanupError', message: String(error) })
        process.exitCode = 1
      }
      await closePool()
    }
  })
  .then(() => process.exit(process.exitCode ?? 0))
