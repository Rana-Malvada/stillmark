import { pgQuery, pgQueryOne, pgTransaction } from '@/lib/postgres'
import { HttpError } from '@/lib/http'
import type { PeopleSettings } from './contracts'
import { lockCorrections, OWNER } from './owner-scope'

export async function getSettings(): Promise<PeopleSettings> {
  const row = await pgQueryOne<PeopleSettings>(
    `SELECT enabled, share_names AS "shareNames" FROM face_settings WHERE owner_username=${OWNER}`,
  )
  return row ?? { enabled: false, shareNames: false }
}
export async function updateSettings(body: Record<string, unknown>): Promise<PeopleSettings> {
  for (const key of ['enabled', 'shareNames'])
    if (key in body && typeof body[key] !== 'boolean') throw new HttpError(400, `Invalid ${key}`)
  return pgTransaction(async () => {
    // PATCH changes one setting at a time. Serialize before the read so concurrent
    // toggles (including the first row insert) cannot restore a stale privacy flag.
    await lockCorrections()
    const current = await getSettings()
    const next = { ...current, ...(body as Partial<PeopleSettings>) }
    await pgQuery(
      `INSERT INTO face_settings(owner_username,enabled,share_names) VALUES(${OWNER},$1,$2)
       ON CONFLICT(owner_username) DO UPDATE SET enabled=$1, share_names=$2, updated_at=now()`,
      [next.enabled, next.shareNames],
    )
    return { enabled: next.enabled, shareNames: next.shareNames }
  })
}

/** Removes every face, person and correction for the caller; crops are queued for deletion. */
export async function deleteFaceData() {
  return pgTransaction(async () => {
    await lockCorrections()
    const crops = await pgQuery<{ crop_path: string }>(
      `SELECT crop_path FROM faces WHERE owner_username=${OWNER} AND crop_path IS NOT NULL`,
    )
    if (crops.length)
      await pgQuery(
        `INSERT INTO stage_cleanup(path,next_attempt) SELECT unnest($1::text[]),now() ON CONFLICT DO NOTHING`,
        [crops.map((c) => c.crop_path)],
      )
    // People first: cover faces would otherwise be nulled row by row.
    await pgQuery(`DELETE FROM face_people WHERE owner_username=${OWNER}`)
    const faces = await pgQuery(`DELETE FROM faces WHERE owner_username=${OWNER} RETURNING face_id`)
    await pgQuery(`DELETE FROM face_corrections WHERE owner_username=${OWNER}`)
    await pgQuery(`DELETE FROM face_scan_queue WHERE owner_username=${OWNER}`)
    await pgQuery(
      `INSERT INTO face_settings(owner_username,enabled,share_names) VALUES(${OWNER},false,false)
       ON CONFLICT(owner_username) DO UPDATE SET enabled=false, share_names=false, updated_at=now()`,
    )
    return { faces: faces.length }
  })
}
