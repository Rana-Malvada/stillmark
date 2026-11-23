import { randomUUID } from 'node:crypto'
import { pgQuery, pgQueryOne, pgTransaction } from '../postgres'
import { storeUploadChunk } from './upload-chunk-stage'
import { MAX_FILE_BYTES } from './upload-limits'
import { HttpError } from '../http'

/** Reserve briefly, write without a database connection, publish with a fence.
 * Every storage attempt has a unique path and a durable cleanup intent. */
export async function writeUploadChunk(
  id: string,
  owner: string,
  total: number,
  index: number,
  hash: string,
  buffer: Buffer,
) {
  const token = randomUUID()
  async function lockSession() {
    const session = await pgQueryOne<{
      owner: string
      total_chunks: number
      bytes: string
      result: unknown
      processing: boolean
    }>(
      `SELECT owner,total_chunks,bytes,result,completion_lease_until>NOW() AS processing
       FROM upload_sessions WHERE upload_id=$1 AND expires_at>NOW() FOR UPDATE`,
      [id],
    )
    if (!session) throw new HttpError(404, 'Upload expired or not found')
    if (session.owner !== owner) throw new HttpError(403, 'Upload belongs to another user')
    if (session.total_chunks !== total) throw new HttpError(409, 'Upload metadata changed')
    return session
  }
  const existing = await pgTransaction(async () => {
    const session = await lockSession()
    if (session.result) return { ok: true, completed: true }
    const previous = await pgQueryOne<{ hash: string }>(
      'SELECT hash FROM upload_chunks WHERE upload_id=$1 AND chunk_index=$2',
      [id, index],
    )
    if (previous) {
      if (previous.hash !== hash) throw new HttpError(409, 'Chunk contents changed')
      return { ok: true, chunkIndex: index }
    }
    if (
      session.processing ||
      (await pgQueryOne('SELECT upload_id FROM upload_processing_jobs WHERE upload_id=$1', [id]))
    )
      throw new HttpError(409, 'Upload is already sealed for processing')
    const old = await pgQueryOne<{ hash: string; active: boolean }>(
      'SELECT hash,lease_until>NOW() AS active FROM upload_chunk_writes WHERE upload_id=$1 AND chunk_index=$2',
      [id, index],
    )
    if (old?.hash && old.hash !== hash) throw new HttpError(409, 'Chunk contents changed')
    if (old?.active) throw new HttpError(429, 'Chunk is already uploading; retry shortly', 2)
    const reserved = await pgQueryOne<{ bytes: string }>(
      'SELECT COALESCE(sum(byte_size),0)::text AS bytes FROM upload_chunk_writes WHERE upload_id=$1 AND chunk_index<>$2 AND lease_until>NOW()',
      [id, index],
    )
    if (Number(session.bytes) + Number(reserved?.bytes ?? 0) + buffer.length > MAX_FILE_BYTES)
      throw new HttpError(413, 'File exceeds 4 GiB')
    await pgQuery(
      `INSERT INTO upload_chunk_writes(upload_id,chunk_index,owner,token,hash,byte_size,lease_until)
       VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '10 minutes') ON CONFLICT(upload_id,chunk_index)
       DO UPDATE SET token=EXCLUDED.token,lease_until=EXCLUDED.lease_until,byte_size=EXCLUDED.byte_size`,
      [id, index, owner, token, hash, buffer.length],
    )
    return null
  })
  if (existing) return existing
  try {
    const path = await storeUploadChunk(id, index, buffer)
    return await pgTransaction(async () => {
      const session = await lockSession()
      const claim = await pgQueryOne(
        'SELECT token FROM upload_chunk_writes WHERE upload_id=$1 AND chunk_index=$2 AND token=$3 AND lease_until>NOW()',
        [id, index, token],
      )
      if (!claim) throw new HttpError(409, 'Chunk upload claim expired; retry upload')
      if (
        session.result ||
        session.processing ||
        (await pgQueryOne('SELECT upload_id FROM upload_processing_jobs WHERE upload_id=$1', [id]))
      )
        throw new HttpError(409, 'Upload is already sealed for processing')
      if (Number(session.bytes) + buffer.length > MAX_FILE_BYTES)
        throw new HttpError(413, 'File exceeds 4 GiB')
      await pgQuery(
        'INSERT INTO upload_chunks(upload_id,chunk_index,stage_path,byte_size,hash) VALUES($1,$2,$3,$4,$5)',
        [id, index, path, buffer.length, hash],
      )
      await pgQuery('UPDATE upload_sessions SET bytes=bytes+$2 WHERE upload_id=$1', [
        id,
        buffer.length,
      ])
      await pgQuery(
        'DELETE FROM upload_chunk_writes WHERE upload_id=$1 AND chunk_index=$2 AND token=$3',
        [id, index, token],
      )
      return { ok: true, chunkIndex: index }
    })
  } catch (error) {
    // The token condition cannot erase a replacement writer's reservation.
    await pgQuery(
      'DELETE FROM upload_chunk_writes WHERE upload_id=$1 AND chunk_index=$2 AND token=$3',
      [id, index, token],
    ).catch(() => {})
    throw error
  }
}
