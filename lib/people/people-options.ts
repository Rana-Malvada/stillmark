import { pgQuery } from '../postgres'
import { HttpError, integer } from '../http'
import { readFaceCursor } from './face-page-cursor'

export type PersonOption = {
  personId: string
  name: string
  coverFaceId?: number | null
  photoCount?: number
}
export type PeopleOptionsPage = { people: PersonOption[]; nextCursor: string | null }

/** Names for owner correction controls, without whole-library face aggregates. */
export async function peopleOptions(
  query: string,
  cursor?: string | null,
  details = false,
): Promise<PeopleOptionsPage> {
  const text = query.trim().toLowerCase()
  if (text.length > 80 || /[\p{Cc}]/u.test(text)) throw new HttpError(400, 'Invalid name search')
  const key = `people-options:${text}`
  const pattern = '%' + text.replace(/[\\%_]/g, '\\$&') + '%'
  const after = readFaceCursor(
    cursor,
    key,
    (v) =>
      v.length === 2 &&
      typeof v[0] === 'string' &&
      v[0].length <= 80 &&
      typeof v[1] === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v[1]),
  )
  const rows = await pgQuery<PersonOption & { sortName: string }>(
    `SELECT p.person_id AS "personId",p.name,lower(p.name) AS "sortName"
     FROM face_people p WHERE p.owner_username=photo_security.username()
       AND p.name IS NOT NULL AND NOT p.hidden
       AND lower(p.name) LIKE $1::text
       AND EXISTS(SELECT FROM face_assignments a JOIN faces f USING(face_id)
         WHERE a.person_id=p.person_id AND NOT f.ignored)
       ${after ? 'AND (lower(p.name),p.person_id)>($2::text,$3::uuid)' : ''}
     ORDER BY lower(p.name),p.person_id LIMIT 51`,
    after ? [pattern, ...after] : [pattern],
  )
  const page = rows.slice(0, 50)
  const last = page.at(-1)
  const metadata =
    details && page.length
      ? await pgQuery<{ personId: string; coverFaceId: number | null; photoCount: number }>(
          `SELECT p.person_id AS "personId", p.cover_face_id AS "coverFaceId",
          count(DISTINCT f.photo_id) FILTER (WHERE a.status<>'suggested')::int AS "photoCount"
         FROM face_people p JOIN face_assignments a USING(person_id)
         JOIN faces f USING(face_id)
         WHERE p.person_id=ANY($1::uuid[]) AND p.owner_username=photo_security.username()
           AND NOT p.hidden AND NOT f.ignored
         GROUP BY p.person_id`,
          [page.map((p) => p.personId)],
        )
      : []
  const byId = new Map(metadata.map((p) => [p.personId, p]))
  return {
    people: page.flatMap(({ sortName: _, ...person }) => {
      if (!details) return [person]
      const detail = byId.get(person.personId)
      return detail
        ? [
            {
              ...person,
              ...detail,
              coverFaceId:
                detail.coverFaceId == null
                  ? null
                  : integer(detail.coverFaceId, 'cover face', 1, Number.MAX_SAFE_INTEGER),
            },
          ]
        : []
    }),
    nextCursor:
      rows.length > 50 && last
        ? Buffer.from(JSON.stringify({ v: 1, k: key, a: [last.sortName, last.personId] })).toString(
            'base64url',
          )
        : null,
  }
}
