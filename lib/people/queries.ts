import { cursorDate, cursorId, cursorNumber, facePage, readFaceCursor } from './face-page-cursor'
import { pgQuery, pgQueryOne } from '@/lib/postgres'
import { HttpError, integer } from '@/lib/http'
import { type FaceItem, personId, type PersonSummary, UUID } from './contracts'
import { OWNER } from './owner-scope'

// Read queries stay separate from corrections; owner filtering and row security
// both apply. Keep cursor predicates and ordering together.
const SUMMARY = `p.person_id AS "personId", p.name, p.hidden, p.cover_face_id AS "coverFaceId",
  COALESCE(c.photo_count,0)::int AS "photoCount",
  COALESCE(c.review_count,0)::int AS "reviewCount"`

/** One page (at most 200) of the caller's people in a category, with optional summary totals. */
export async function listPeople(paging: {
  kind: string
  cursor?: string | null
  includeTotals?: boolean
}) {
  const kind = paging.kind
  if (!['all', 'named', 'unnamed', 'hidden', 'none'].includes(kind))
    throw new HttpError(400, 'Invalid people category')
  const key = `people-overview:${kind}`
  const after = readFaceCursor(
    paging.cursor,
    key,
    (v) =>
      v.length === 4 &&
      typeof v[0] === 'boolean' &&
      typeof v[1] === 'string' &&
      v[1].length <= 80 &&
      Number.isSafeInteger(v[2]) &&
      Number(v[2]) <= 0 &&
      Number(v[2]) >= -2147483647 &&
      typeof v[3] === 'string' &&
      UUID.test(v[3]),
  )
  const category =
    kind === 'named'
      ? 'AND p.name IS NOT NULL AND NOT p.hidden'
      : kind === 'unnamed'
        ? 'AND p.name IS NULL AND NOT p.hidden'
        : kind === 'hidden'
          ? 'AND p.hidden'
          : ''
  const rows =
    kind === 'none'
      ? []
      : await pgQuery<
          PersonSummary & { sortCount: number; _cursor: (string | number | boolean | null)[] }
        >(
          `SELECT grouped.*,jsonb_build_array(name IS NULL,COALESCE(lower(name),''),-"sortCount","personId") AS _cursor FROM (
       SELECT ${SUMMARY},c.sort_count AS "sortCount" FROM face_people p
       JOIN photo_security.person_counts(NULL) c ON c.person_id=p.person_id
       WHERE p.owner_username=${OWNER} ${category}
     ) grouped
     ${after ? `WHERE (name IS NULL,COALESCE(lower(name),''),-"sortCount","personId")>($1::boolean,$2::text,$3::int,$4::uuid)` : ''}
     ORDER BY name IS NULL,lower(name),"sortCount" DESC,"personId" LIMIT 201`,
          after ?? [],
        )
  const result = facePage(rows, key)
  const people = result.faces.map(({ sortCount: _, ...person }) => person)
  const includeTotals = paging.includeTotals !== false
  const totals = includeTotals
    ? await pgQueryOne<{
        review: number
        unknown: number
        lowerConfidence: number
        ignored: number
        unnamed: number
        people: number
      }>(`SELECT * FROM photo_security.people_totals()`)
    : null
  return {
    named: people.filter((p) => p.name && !p.hidden),
    unnamed: people.filter((p) => !p.name && !p.hidden),
    hidden: people.filter((p) => p.hidden),
    nextCursor: result.nextCursor,
    more: result.more,
    ...(totals
      ? {
          reviewCount: totals.review,
          unknownCount: totals.unknown,
          lowerConfidenceCount: totals.lowerConfidence,
          ignoredCount: totals.ignored,
          unnamedCount: totals.unnamed,
          peopleCount: totals.people,
        }
      : {}),
  }
}

const FACE = `f.face_id AS "faceId", f.photo_id AS "photoId", ph.event_id AS "eventId",
  ph.thumbnail_stage_path AS "thumbnailPath", (f.crop_path IS NOT NULL) AS "hasCrop", f.source`
const page = (offset: unknown) => integer(offset ?? 0, 'offset', 0, 1_000_000)

export async function getPerson(
  id: string,
  offset?: unknown,
  cursor?: unknown,
  includeSummary = true,
) {
  const person = includeSummary
    ? await pgQueryOne<PersonSummary>(
        `SELECT ${SUMMARY} FROM face_people p
     LEFT JOIN photo_security.person_counts($1::uuid) c ON c.person_id=p.person_id
     WHERE p.person_id=$1 AND p.owner_username=${OWNER}`,
        [personId(id)],
      )
    : await pgQueryOne<{ personId: string }>(
        `SELECT person_id AS "personId" FROM face_people WHERE person_id=$1 AND owner_username=${OWNER}`,
        [personId(id)],
      )
  if (!person) throw new HttpError(404, 'Person not found')
  const key = `person:${person.personId}`
  const position = readFaceCursor(
    cursor,
    key,
    (v) => v.length === 3 && typeof v[0] === 'boolean' && cursorDate(v[1]) && cursorId(v[2]),
  )
  const faces = await pgQuery<FaceItem & { _cursor: (string | number | boolean | null)[] }>(
    `SELECT ${FACE}, a.status, a.score, jsonb_build_array(a.status='suggested',ph.date_taken::text,f.face_id) AS _cursor FROM face_assignments a JOIN faces f USING(face_id)
     JOIN photos ph ON ph.photo_id=f.photo_id
     WHERE a.person_id=$1 AND NOT f.ignored
     ${position ? "AND (a.status='suggested',COALESCE(ph.date_taken,'-infinity'::timestamptz),f.face_id) < ($3::boolean,COALESCE($4::timestamptz,'-infinity'::timestamptz),$5::bigint)" : ''}
     ORDER BY (a.status='suggested') DESC, ph.date_taken DESC NULLS LAST, f.face_id DESC LIMIT 201 OFFSET $2`,
    [person.personId, position ? 0 : page(offset), ...(position ?? [])],
  )
  return { ...(includeSummary ? { person } : {}), ...facePage(faces, key) }
}

/** Suggested matches grouped by person for bulk confirmation, strongest first within each person. */
export async function reviewQueue(offset?: unknown, cursor?: unknown) {
  const key = 'review'
  const position = readFaceCursor(
    cursor,
    key,
    (v) =>
      v.length === 6 &&
      typeof v[0] === 'boolean' &&
      typeof v[1] === 'string' &&
      v[1].length <= 80 &&
      typeof v[2] === 'string' &&
      UUID.test(v[2]) &&
      typeof v[3] === 'boolean' &&
      typeof v[4] === 'number' &&
      Number.isFinite(v[4]) &&
      cursorId(v[5]),
  )
  const faces = await pgQuery<FaceItem & { _cursor: (string | number | boolean | null)[] }>(
    `SELECT ${FACE}, a.status, a.score, p.person_id AS "personId", p.name AS "personName",
     jsonb_build_array(p.name IS NULL,COALESCE(lower(p.name),''),p.person_id,a.score IS NULL,-COALESCE(a.score,0),f.face_id) AS _cursor
     FROM face_assignments a JOIN faces f USING(face_id) JOIN face_people p ON p.person_id=a.person_id
     JOIN photos ph ON ph.photo_id=f.photo_id
     WHERE a.owner_username=${OWNER} AND a.status='suggested' AND NOT f.ignored
     ${position ? "AND (p.name IS NULL,COALESCE(lower(p.name),''),p.person_id,a.score IS NULL,-COALESCE(a.score,0),f.face_id) > ($2::boolean,$3::text,$4::uuid,$5::boolean,$6::real,$7::bigint)" : ''}
     ORDER BY lower(p.name) NULLS LAST, p.person_id, a.score DESC NULLS LAST, f.face_id LIMIT 201 OFFSET $1`,
    [position ? 0 : page(offset), ...(position ?? [])],
  )
  return facePage(faces, key)
}

/** Faces with no person, best quality first; `ignored` lists faces the owner set aside. */
export async function unknownFaces(
  offset?: unknown,
  ignored = false,
  quality = 'all',
  cursor?: unknown,
) {
  if (!['all', 'higher', 'lower'].includes(quality))
    throw new HttpError(400, 'Invalid quality filter')
  const key = `unknown:${ignored}:${quality}`
  const position = readFaceCursor(
    cursor,
    key,
    (v) => v.length === 2 && cursorNumber(v[0]) && cursorId(v[1]),
  )
  const faces = await pgQuery<FaceItem & { _cursor: (string | number | boolean | null)[] }>(
    `SELECT ${FACE}, jsonb_build_array(f.quality,f.face_id) AS _cursor, f.quality_ok AS "qualityOk", NULL AS status, NULL::real AS score FROM faces f JOIN photos ph ON ph.photo_id=f.photo_id
     WHERE f.owner_username=${OWNER} AND f.ignored=$2
       AND ($2 OR (NOT EXISTS(SELECT FROM face_assignments a WHERE a.face_id=f.face_id)
         AND ($3='all' OR f.quality_ok=($3='higher'))))
     ${position ? "AND (COALESCE(f.quality,'-Infinity'::real),f.face_id) < (COALESCE($4::real,'-Infinity'::real),$5::bigint)" : ''}
     ORDER BY f.quality DESC NULLS LAST, f.face_id DESC LIMIT 201 OFFSET $1`,
    [position ? 0 : page(offset), ignored, quality, ...(position ?? [])],
  )
  return facePage(faces, key)
}

/**
 * Faces in one photo for the Info panel. Owners see every face with boxes and
 * suggestions, with ignored faces in a separate owner-only collection. Shared
 * viewers see only what row security exposes (settled, named, not ignored).
 * Faces of hidden people are left out for everyone.
 */
export async function photoPeople(photoId: number) {
  const owner = await pgQueryOne<{ owns: boolean; enabled: boolean }>(
    `SELECT photo_security.photo_owner($1)=${OWNER} AS owns,
       COALESCE((SELECT enabled FROM face_settings WHERE owner_username=${OWNER}),false) AS enabled`,
    [photoId],
  )
  const faces = await pgQuery<
    FaceItem & { ignored: boolean; box: { x: number; y: number; w: number; h: number } | null }
  >(
    `SELECT f.face_id AS "faceId", f.photo_id AS "photoId", (f.crop_path IS NOT NULL) AS "hasCrop", f.source,
       CASE WHEN f.box_x IS NULL THEN NULL ELSE json_build_object('x',f.box_x,'y',f.box_y,'w',f.box_w,'h',f.box_h) END AS box,
       f.ignored, a.status, a.score, p.person_id AS "personId", p.name AS "personName"
     FROM faces f LEFT JOIN face_assignments a ON a.face_id=f.face_id
     LEFT JOIN face_people p ON p.person_id=a.person_id
     WHERE f.photo_id=$1 AND ($2 OR NOT f.ignored) AND NOT COALESCE(p.hidden, false)
       AND ($2 OR f.quality_ok OR f.source='manual' OR a.status IS NOT NULL)
     ORDER BY f.box_x NULLS LAST, f.face_id`,
    [photoId, owner?.owns ?? false],
  )
  // node-postgres returns BIGINT as text. Keep face IDs consistent with URL IDs
  // and client-side selection without changing the driver's global type handling.
  const normalizedFaces = faces.map((face) => ({
    ...face,
    faceId: integer(face.faceId, 'face', 1, Number.MAX_SAFE_INTEGER),
  }))
  const owns = !!owner?.owns
  return {
    canEdit: owns && owner!.enabled,
    ignoredFaces: owns ? normalizedFaces.filter((f) => f.ignored) : [],
    faces: owns
      ? normalizedFaces.filter((f) => !f.ignored)
      : normalizedFaces
          .filter((f) => !f.ignored && f.personName && f.status !== 'suggested')
          .map(({ faceId, hasCrop, personId, personName }) => ({
            faceId,
            hasCrop,
            personId,
            personName,
          })),
  }
}

/** Recent corrections, newest first; only the newest open one can be undone. */
export async function history() {
  const rows = await pgQuery<{
    id: number
    kind: string
    summary: string
    createdAt: string
    undoneAt: string | null
  }>(
    `SELECT id, kind, summary, created_at AS "createdAt", undone_at AS "undoneAt" FROM face_corrections
     WHERE owner_username=${OWNER} ORDER BY id DESC LIMIT 50`,
  )
  const open = rows.find((r) => !r.undoneAt)
  return rows.map((r) => ({ ...r, canUndo: r.id === open?.id }))
}
