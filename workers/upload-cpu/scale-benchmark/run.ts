/** Finite producer; stages fixed existing media into a private fixture only. */
import { createHash, randomUUID } from 'node:crypto'
import { databaseContext } from '../../../lib/database/database-context'
import {
  closePool,
  pgAuthMainAdmin,
  pgQuery,
  pgQueryOne,
  pgTransaction,
} from '../../../lib/postgres'
import { saveChunk } from '../../../lib/upload/upload-sessions'
import { enqueueUpload } from '../../../lib/upload/upload-processing-jobs'
import { closePool as closeSnowflake, querySnowflakeStorage } from '../../../lib/snowflake'
import { STAGE } from '../../../lib/snowflake/storage-constants'
import { CHUNK_BYTES } from '../../../lib/upload/upload-limits'

const owner = process.env.VALIDATE_OWNER!
const eventId = Number(process.env.VALIDATE_EVENT_ID)
const ids = JSON.parse(process.env.BENCH_SOURCE_IDS || '[]') as number[]
if (
  !owner ||
  !Number.isSafeInteger(eventId) ||
  eventId < 1 ||
  !Array.isArray(ids) ||
  ids.length !== 32 ||
  new Set(ids).size !== 32 ||
  ids.some((i) => !Number.isSafeInteger(i) || i < 1)
)
  throw Error('Explicit owner, fixture and 32 unique source IDs required')
const caller = { username: owner, role: 'admin' as const, mainAdmin: true, canManagePersonal: true }
const identity = {
  username: owner,
  mainAdmin: true,
  adminRead: true,
  adminWrite: true,
  canWrite: true,
  accessManager: false,
}
async function run() {
  if (!(await pgAuthMainAdmin(owner))) throw Error('Main administrator required')
  await databaseContext.run(
    { kind: 'request', identity: Promise.resolve(identity), caller: Promise.resolve(caller) },
    async () => {
      const event = await pgQueryOne<{
        event_name: string
        visibility: string
        owner_username: string
        folder_id: number
      }>('SELECT event_name,visibility,owner_username,folder_id FROM events WHERE event_id=$1', [
        eventId,
      ])
      if (
        !event?.event_name.startsWith('__upload_scale_benchmark_') ||
        event.visibility !== 'PRIVATE' ||
        event.owner_username !== owner ||
        !event.folder_id
      )
        throw Error('Private benchmark fixture required')
      const existing = await pgQueryOne<{ n: number }>(
        "SELECT count(*)::int n FROM upload_processing_jobs WHERE body->>'eventId'=$1",
        [String(eventId)],
      )
      if (existing?.n) throw Error('Fixture already used; do not enqueue twice')
      const sources = await pgQuery<{
        photo_id: number
        original_stage_path: string
        file_size_bytes: string
        file_hash: string
        file_extension: string
      }>(
        `SELECT photo_id,original_stage_path,file_size_bytes,file_hash,file_extension FROM photos WHERE photo_id=ANY($1::int[]) ORDER BY photo_id`,
        [ids],
      )
      if (sources.length !== 32) throw Error('Missing sources')
      for (const src of sources) {
        if (
          !['jpg', 'jpeg', 'mp4', 'mov'].includes(src.file_extension.toLowerCase()) ||
          Number(src.file_size_bytes) > 64000000
        )
          throw Error('Unsupported or oversized sample')
        const urls = await querySnowflakeStorage(
          `SELECT GET_PRESIGNED_URL(${STAGE}, '${src.original_stage_path.replaceAll("'", "''")}', 300) AS URL`,
        )
        const res = await fetch(urls[0].URL ?? urls[0].url, { signal: AbortSignal.timeout(60000) })
        if (!res.ok) throw Error('Sample read failed')
        const bytes = Buffer.from(await res.arrayBuffer())
        if (
          bytes.length !== Number(src.file_size_bytes) ||
          createHash('sha256').update(bytes).digest('hex') !== src.file_hash
        )
          throw Error('Sample integrity mismatch')
        const id = randomUUID()
        const filename = `scale-${src.photo_id}.${src.file_extension.toLowerCase()}`
        const total = Math.ceil(bytes.length / CHUNK_BYTES)
        for (let i = 0; i < total; i++) {
          const form = new FormData()
          form.set('uploadId', id)
          form.set('totalChunks', String(total))
          form.set('chunkIndex', String(i))
          form.set(
            'chunk',
            new File([bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)], filename),
          )
          await saveChunk(owner, form)
        }
        // Atomic delayed admission: no worker can see a ready job until the operator releases the trial.
        await pgTransaction(async () => {
          await enqueueUpload({
            uploadId: id,
            totalChunks: total,
            fileName: filename,
            eventId,
            folderId: event.folder_id,
            folderName: event.event_name,
          })
          await pgQuery(
            "UPDATE upload_processing_jobs SET next_attempt=now()+interval '24 hours' WHERE upload_id=$1 AND state='queued'",
            [id],
          )
        })
        console.log(
          'SCALE_BENCH ' +
            JSON.stringify({
              event: 'staged',
              uploadId: id,
              sourceId: src.photo_id,
              eventId,
              bytes: bytes.length,
            }),
        )
      }
      console.log('SCALE_BENCH ' + JSON.stringify({ event: 'ready', eventId, count: 32 }))
    },
  )
}
run()
  .then(async () => {
    await closePool()
    await closeSnowflake()
    process.exit(0)
  })
  .catch((e) => {
    console.error('SCALE_BENCH failed', e instanceof Error ? e.message : 'unknown')
    process.exit(1)
  })
