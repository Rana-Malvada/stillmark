import { withServiceDatabase } from '../database/database-context'
import { mediaStage } from './media-stage'
import { pgIndependent, pgQuery } from '@/lib/postgres'
import { querySnowflakeStorage } from '@/lib/snowflake'
import { link, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { STAGE } from '@/lib/snowflake/storage-constants'
import { storageByteCache } from './storage-byte-cache'

const UPLOAD_TMP = join(tmpdir(), 'photo-upload')

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function putFileToStage(buffer: Buffer | string, stagePath: string): Promise<void> {
  const batchId = randomUUID()
  const stageDir = dirname(stagePath)
  const fileName = stagePath.split('/').pop()!
  const localDir = join(UPLOAD_TMP, batchId)
  const localFile = join(localDir, fileName)

  await pgIndependent('SELECT photo_security.reserve_stage_upload($1)', [stagePath])
  await mkdir(localDir, { recursive: true })
  try {
    if (typeof buffer === 'string') await link(buffer, localFile)
    else await writeFile(localFile, buffer)
    const escapedFile = localFile.replace(/'/g, "\\'")
    const escapedStageDir = stageDir.replace(/'/g, "\\'")
    const sql = `PUT 'file://${escapedFile}' '${STAGE}/${escapedStageDir}/' AUTO_COMPRESS=FALSE OVERWRITE=TRUE`

    // Retry up to 3 times on transient connection errors
    let lastErr: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rows = await querySnowflakeStorage(sql)
        if (
          !rows.length ||
          rows.some((row) => !['UPLOADED', 'SKIPPED'].includes(String(row.status ?? row.STATUS)))
        )
          throw new Error('Stage upload did not complete')
        if (stagePath.startsWith('display/')) {
          storageByteCache.delete(`ai:${stagePath}`)
          storageByteCache.delete(`display:${stagePath}`)
          // The dedicated upload service does not run photo AI. Do not copy bytes
          // there for a consumer in another process that cannot reuse them.
          if (process.env.UPLOAD_SERVICE_ONLY !== 'true' && Buffer.isBuffer(buffer))
            storageByteCache.set(`display:${stagePath}`, buffer)
        }
        return
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e))
        const msg = lastErr.message.toLowerCase()
        if (
          msg.includes('terminated connection') ||
          msg.includes('connection was destroyed') ||
          msg.includes('network error')
        ) {
          await sleep(1000 * (attempt + 1))
          continue
        }
        throw lastErr
      }
    }
    throw lastErr
  } finally {
    try {
      await rm(localDir, { recursive: true, force: true })
    } catch {
      /* cleanup */
    }
  }
}

// Upload files with controlled concurrency to avoid overwhelming the connection pool
export async function putFilesToStage(
  files: Array<{ buffer: Buffer | string; stagePath: string }>,
): Promise<void> {
  // Run 3 at a time instead of all at once
  const CONCURRENCY = 3
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map((f) => putFileToStage(f.buffer, f.stagePath)))
  }
}

/** Cleanup intents survive metadata rollback. Live catalog references always win. */
function cleanupSql(paths: string[]): string {
  // Only temporary chunks are batched; permanent objects retain exact-path scope.
  const path = paths[0]
  const prefix = path.startsWith('upload-chunks/') ? 'upload-chunks/' : path
  if (
    paths.some(
      (p) =>
        !p ||
        p.split('/').some((part) => !part || part === '.' || part === '..') ||
        /[\\\r\n]/.test(p),
    )
  ) {
    throw new Error('Invalid cleanup path')
  }
  const quote = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "''")
  const alternatives = paths.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = `(^|.*/)(${alternatives.join('|')})$`
  return `REMOVE '${quote(`${mediaStage(path)}/${prefix}`)}' PATTERN='${quote(pattern)}'`
}

async function cleanupStageService(): Promise<void> {
  const token = randomUUID()
  const paths = await pgQuery<{ path: string }>(
    'SELECT path FROM photo_security.claim_stage_cleanup($1::uuid)',
    [token],
  )
  const groups = new Map<string, string[]>()
  for (const { path } of paths) {
    const key = path.startsWith('upload-chunks/') ? 'upload-chunks/' : path
    groups.set(key, [...(groups.get(key) ?? []), path])
  }
  for (const paths of groups.values()) {
    // Keep the claimed batch alive while draining; no transaction spans storage I/O.
    const renewed = await pgQuery<{ path: string }>(
      "UPDATE stage_cleanup SET lease_until=now()+interval '30 minutes' WHERE claim_token=$1 AND path=ANY($2::text[]) RETURNING path",
      [token, paths],
    )
    const owned = renewed.map((row) => row.path)
    if (!owned.length) continue
    try {
      await querySnowflakeStorage(cleanupSql(owned))
      await pgQuery('DELETE FROM stage_cleanup WHERE path=ANY($1::text[]) AND claim_token=$2', [
        paths,
        token,
      ])
    } catch (error) {
      await pgQuery(
        "UPDATE stage_cleanup SET attempts=attempts+1,next_attempt=now()+interval '1 hour',last_error=$3,claim_token=NULL,lease_until=NULL WHERE path=ANY($1::text[]) AND claim_token=$2",
        [paths, token, error instanceof Error ? error.message.slice(0, 500) : 'Cleanup failed'],
      )
    }
  }
}

export function cleanupStage(...args: Parameters<typeof cleanupStageService>) {
  return withServiceDatabase(() => cleanupStageService(...args))
}
