import { pgQuery, pgQueryOne, pgTransaction } from '@/lib/postgres'
import { HttpError, integer } from '@/lib/http'
import { lockCorrections, OWNER } from './owner-scope'

// Correction transaction boundary: ownership locks, before-state, mutation and
// history insertion commit together. Undo uses the same owner lock and snapshot.
type Kind =
  | 'rename'
  | 'confirm'
  | 'reject'
  | 'assign'
  | 'merge'
  | 'split'
  | 'ignore'
  | 'unignore'
  | 'hide'
  | 'unhide'
  | 'cover'

interface Change {
  faces?: number[]
  people?: string[]
}
export interface Snapshot {
  faces: number[]
  people: Record<string, unknown>[]
  assignments: Record<string, unknown>[]
  rejections: Record<string, unknown>[]
  ignored: { face_id: number; ignored: boolean }[]
  createdPeople: string[]
  createdFaces: number[]
}

/** Every face whose assignment or rejection may change: the named faces and all faces of the people. */
async function snapshot({ faces = [], people = [] }: Change): Promise<Snapshot> {
  const row = await pgQueryOne<Omit<Snapshot, 'createdPeople' | 'createdFaces'>>(
    `WITH touched AS (
       SELECT unnest($1::bigint[]) AS face_id
       UNION SELECT face_id FROM face_assignments WHERE person_id=ANY($2::uuid[])
       UNION SELECT face_id FROM face_rejections WHERE person_id=ANY($2::uuid[]))
     SELECT
      (SELECT COALESCE(array_agg(face_id ORDER BY face_id),'{}') FROM touched) AS faces,
      (SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]') FROM face_people p
        WHERE p.person_id=ANY($2::uuid[]) OR p.person_id IN (SELECT person_id FROM face_assignments WHERE face_id IN (SELECT face_id FROM touched))) AS people,
      (SELECT COALESCE(jsonb_agg(to_jsonb(a)),'[]') FROM face_assignments a WHERE a.face_id IN (SELECT face_id FROM touched)) AS assignments,
      (SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM face_rejections r WHERE r.face_id IN (SELECT face_id FROM touched)) AS rejections,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('face_id',f.face_id,'ignored',f.ignored)),'[]') FROM faces f
        WHERE f.face_id IN (SELECT face_id FROM touched)) AS ignored`,
    [faces, people],
  )
  return { ...row!, faces: row!.faces.map(Number), createdPeople: [], createdFaces: [] }
}

/** Runs one correction: checks ownership, snapshots, applies, and records it for undo. */
export async function correct<T>(
  kind: Kind,
  summary: string,
  change: Change,
  apply: (state: Snapshot) => Promise<T>,
): Promise<T & { correctionId: number }> {
  return pgTransaction(async () => {
    await lockCorrections()
    const people = change.people ?? []
    if (people.length) {
      const owned = await pgQuery(
        `SELECT person_id FROM face_people WHERE person_id=ANY($1::uuid[]) AND owner_username=${OWNER} ORDER BY person_id FOR UPDATE`,
        [people],
      )
      if (owned.length !== new Set(people).size) throw new HttpError(404, 'Person not found')
    }
    const faces = change.faces ?? []
    if (faces.length) {
      const owned = await pgQuery(
        `SELECT face_id FROM faces WHERE face_id=ANY($1::bigint[]) AND owner_username=${OWNER} ORDER BY face_id FOR UPDATE`,
        [faces],
      )
      if (owned.length !== faces.length) throw new HttpError(404, 'Face not found')
    }
    const state = await snapshot(change)
    const result = await apply(state)
    const row = await pgQueryOne<{ id: number }>(
      `INSERT INTO face_corrections(owner_username,kind,summary,before_state,created_by)
       VALUES(${OWNER},$1,$2,$3::jsonb,${OWNER}) RETURNING id`,
      [kind, summary, JSON.stringify(state)],
    )
    // The id lets Undo reverse exactly this change, not whatever is newest.
    return { ...result, correctionId: Number(row!.id) }
  })
}

/** Keeps a valid cover: the existing one if still assigned, else the best settled face. */
export async function refreshCovers(people: string[]) {
  await pgQuery(
    `UPDATE face_people p SET updated_at=now(), cover_face_id=COALESCE(
       (SELECT a.face_id FROM face_assignments a JOIN faces f USING(face_id)
         WHERE a.person_id=p.person_id AND a.face_id=p.cover_face_id AND NOT f.ignored AND f.crop_path IS NOT NULL),
       (SELECT a.face_id FROM face_assignments a JOIN faces f USING(face_id)
         WHERE a.person_id=p.person_id AND NOT f.ignored AND f.crop_path IS NOT NULL
         ORDER BY (a.status='suggested'), f.quality DESC NULLS LAST, f.face_id LIMIT 1))
     WHERE p.person_id=ANY($1::uuid[])`,
    [people],
  )
}

/** Reverts the newest open correction by restoring its snapshot. */
export async function undo(id: unknown) {
  const correctionId = integer(id, 'correction', 1, Number.MAX_SAFE_INTEGER)
  return pgTransaction(async () => {
    await lockCorrections()
    const latest = await pgQueryOne<{ id: number; summary: string; before_state: Snapshot }>(
      `SELECT id, summary, before_state FROM face_corrections WHERE owner_username=${OWNER} AND undone_at IS NULL
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    )
    if (!latest || Number(latest.id) !== correctionId)
      throw new HttpError(409, 'Only the most recent change can be undone')
    const s = latest.before_state
    const people = JSON.stringify(s.people)
    if (s.createdFaces.length)
      await pgQuery(`DELETE FROM faces WHERE face_id=ANY($1::bigint[])`, [s.createdFaces])
    await pgQuery(
      `INSERT INTO face_people(person_id,owner_username,name,cover_face_id,hidden,created_at,updated_at)
       SELECT person_id,owner_username,name,NULL,hidden,created_at,now() FROM jsonb_populate_recordset(NULL::face_people,$1::jsonb)
       ON CONFLICT(person_id) DO UPDATE SET name=EXCLUDED.name, hidden=EXCLUDED.hidden, updated_at=now()`,
      [people],
    )
    await pgQuery(`DELETE FROM face_assignments WHERE face_id=ANY($1::bigint[])`, [s.faces])
    await pgQuery(`DELETE FROM face_rejections WHERE face_id=ANY($1::bigint[])`, [s.faces])
    // Faces removed since (a deleted photo) are skipped.
    await pgQuery(
      `INSERT INTO face_rejections(face_id,person_id,owner_username,created_at)
       SELECT r.face_id,r.person_id,r.owner_username,r.created_at FROM jsonb_populate_recordset(NULL::face_rejections,$1::jsonb) r
       WHERE EXISTS(SELECT FROM faces f WHERE f.face_id=r.face_id)`,
      [JSON.stringify(s.rejections)],
    )
    await pgQuery(
      `INSERT INTO face_assignments(face_id,person_id,owner_username,status,score)
       SELECT a.face_id,a.person_id,a.owner_username,a.status,a.score FROM jsonb_populate_recordset(NULL::face_assignments,$1::jsonb) a
       WHERE EXISTS(SELECT FROM faces f WHERE f.face_id=a.face_id)`,
      [JSON.stringify(s.assignments)],
    )
    await pgQuery(
      `UPDATE faces f SET ignored=x.ignored FROM jsonb_to_recordset($1::jsonb) AS x(face_id bigint, ignored boolean)
       WHERE f.face_id=x.face_id AND f.ignored<>x.ignored`,
      [JSON.stringify(s.ignored)],
    )
    await pgQuery(
      `UPDATE face_people p SET cover_face_id=x.cover_face_id FROM jsonb_to_recordset($1::jsonb) AS x(person_id uuid, cover_face_id bigint)
       WHERE p.person_id=x.person_id AND EXISTS(SELECT FROM faces f WHERE f.face_id=x.cover_face_id)`,
      [people],
    )
    if (s.createdPeople.length)
      await pgQuery(`DELETE FROM face_people WHERE person_id=ANY($1::uuid[])`, [s.createdPeople])
    // A tag may have changed the cover of a person outside the snapshot; repair any stale cover.
    const stale = await pgQuery<{ person_id: string }>(
      `SELECT p.person_id FROM face_people p WHERE p.owner_username=${OWNER} AND (p.cover_face_id IS NULL OR NOT EXISTS(
         SELECT FROM face_assignments a WHERE a.person_id=p.person_id AND a.face_id=p.cover_face_id))`,
    )
    if (stale.length) await refreshCovers(stale.map((p) => p.person_id))
    await pgQuery(`UPDATE face_corrections SET undone_at=now() WHERE id=$1`, [correctionId])
    return { undone: latest.summary }
  })
}
