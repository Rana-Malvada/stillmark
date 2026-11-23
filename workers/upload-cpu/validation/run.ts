import { randomBytes, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { databaseContext } from '../../../lib/database/database-context'
import { closePool, pgAuthMainAdmin, pgQueryOne } from '../../../lib/postgres'
import { saveChunk } from '../../../lib/upload/upload-sessions'
import { enqueueUpload } from '../../../lib/upload/upload-processing-jobs'
import { claimUploadJob } from '../../../lib/upload/upload-processing-worker'
import { claimUploadCompletion } from '../../../lib/upload/upload-completion-claim'
import { uploadQueuePool } from '../../../lib/upload/upload-queue-database'
import { closePool as closeSnowflake } from '../../../lib/snowflake'

const owner = process.env.VALIDATE_OWNER!
const eventId = Number(process.env.VALIDATE_EVENT_ID)
const count = Number(process.env.VALIDATE_COUNT || '8')
const mode = process.env.VALIDATE_MODE || 'enqueue'
if (
  !owner ||
  !Number.isSafeInteger(eventId) ||
  eventId < 1 ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  count > 80 ||
  !['enqueue', 'abandon'].includes(mode)
)
  throw Error('Explicit bounded validation inputs required')
const caller = { username: owner, role: 'admin' as const, mainAdmin: true, canManagePersonal: true }
const identity = {
  username: owner,
  mainAdmin: true,
  adminRead: true,
  adminWrite: true,
  canWrite: true,
  accessManager: false,
}
const emit = (v: unknown) => console.log('UPLOAD_VALIDATION ' + JSON.stringify(v))
async function run() {
  if (!(await pgAuthMainAdmin(owner)))
    throw Error('Validation owner must be an existing main administrator')
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
        !event?.event_name.startsWith('__upload_validation_') ||
        event.visibility !== 'PRIVATE' ||
        event.owner_username !== owner ||
        !event.folder_id
      )
        throw Error('Isolated private validation album required')
      if (mode === 'abandon') {
        const outstanding = await uploadQueuePool().query(
          "SELECT count(*)::int n FROM upload_processing_jobs WHERE state IN ('queued','processing') AND coalesce(body->>'eventId','')<>$1",
          [String(eventId)],
        )
        if (outstanding.rows[0].n) throw Error('Unrelated jobs present; do not steal a live upload')
        const job = await claimUploadJob()
        if (!job || Number(job.body.eventId) !== eventId) throw Error('No isolated job claimed')
        await claimUploadCompletion(job.upload_id, owner, job.lease_token)
        emit({ event: 'abandoned_claim', uploadId: job.upload_id, attempt: job.attempts })
        return // Exit with both leases intact: simulate a consumer disappearing before publication.
      }
      for (let i = 0; i < count; i++) {
        const id = randomUUID()
        const filename = `validation-${id}.jpg`
        const bytes = await sharp(randomBytes(1536 * 1024 * 3), {
          raw: { width: 1536, height: 1024, channels: 3 },
        })
          .jpeg({ quality: 88 })
          .toBuffer()
        const f = new FormData()
        f.set('uploadId', id)
        f.set('totalChunks', '1')
        f.set('chunkIndex', '0')
        f.set('chunk', new File([bytes], filename))
        await saveChunk(owner, f)
        const body = {
          uploadId: id,
          totalChunks: 1,
          fileName: filename,
          folderName: event.event_name,
          eventId,
          folderId: event.folder_id,
        }
        const result = await enqueueUpload(body)
        const replay = await enqueueUpload(body)
        if (!result.queued || (!replay.queued && !replay.results))
          throw Error('Unexpected acceptance or replay')
        emit({ event: 'accepted', uploadId: id, eventId, bytes: bytes.length })
      }
      emit({ event: 'producer_finished', count, eventId })
    },
  )
}
run()
  .then(async () => {
    await closePool()
    await closeSnowflake()
    if (mode === 'abandon') await uploadQueuePool().end()
    process.exit(0)
  })
  .catch((e) => {
    console.error('UPLOAD_VALIDATION failed', e instanceof Error ? e.message : 'unknown')
    process.exit(1)
  })
