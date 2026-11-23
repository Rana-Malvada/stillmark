import { pgQuery, pgQueryOne, pgTransaction } from '@/lib/postgres'
import { HttpError, integer } from '@/lib/http'
import { faceBox, faceIds, personId, personName } from './contracts'
import { lockCorrections, OWNER } from './owner-scope'
import { correct, refreshCovers, type Snapshot } from './correction-store'

// Owner correction commands. Every write goes through the shared transaction
// boundary; multi-step group/name resolution holds that same owner lock.
/** Do not silently choose one identity when legacy data contains duplicate names. */
async function existingName(name: string) {
  const rows = await pgQuery<{ person_id: string; hidden: boolean }>(
    `SELECT person_id,hidden FROM face_people WHERE owner_username=${OWNER} AND lower(name)=lower($1) ORDER BY person_id LIMIT 2`,
    [name],
  )
  if (rows.length > 1)
    throw new HttpError(409, 'More than one person has this name. Choose the intended person.')
  return rows[0] ?? null
}

async function nameTaken(name: string, except: string | null = null) {
  const row = await pgQueryOne(
    `SELECT 1 FROM face_people WHERE owner_username=${OWNER} AND lower(name)=lower($1)
     AND person_id IS DISTINCT FROM $2::uuid`,
    [name, except],
  )
  if (row) throw new HttpError(409, 'Someone already has this name. Merge them instead.')
}

async function createPerson(state: Snapshot, name: string | null) {
  if (name) await nameTaken(name)
  const row = await pgQueryOne<{ person_id: string }>(
    `INSERT INTO face_people(owner_username,name) VALUES(${OWNER},$1) RETURNING person_id`,
    [name],
  )
  state.createdPeople.push(row!.person_id)
  return row!.person_id
}

/** Confirmed assignment of faces to a person, overriding earlier rejections of that pair. */
async function assignFaces(faces: number[], person: string) {
  await pgQuery(`DELETE FROM face_rejections WHERE face_id=ANY($1::bigint[]) AND person_id=$2`, [
    faces,
    person,
  ])
  await pgQuery(
    `INSERT INTO face_assignments(face_id,person_id,owner_username,status)
     SELECT unnest($1::bigint[]),$2,${OWNER},'confirmed'
     ON CONFLICT(face_id) DO UPDATE SET person_id=EXCLUDED.person_id,status='confirmed',score=NULL`,
    [faces, person],
  )
  await pgQuery(`UPDATE faces SET ignored=false WHERE face_id=ANY($1::bigint[]) AND ignored`, [
    faces,
  ])
  await refreshCovers([person])
}

/** Resolves an assignment target: an existing person, or a name (existing or new). */
async function target(state: Snapshot, body: Record<string, unknown>) {
  if (body.personId != null) return personId(body.personId)
  const name = personName(body.name)
  const existing = await existingName(name)
  return existing?.person_id ?? createPerson(state, name)
}

export async function renamePerson(id: string, value: unknown) {
  const person = personId(id)
  const name = value === null || value === '' ? null : personName(value)
  return correct(
    'rename',
    name ? `Named a person ${name}` : 'Removed a name',
    { people: [person] },
    async () => {
      if (name) await nameTaken(name, person)
      await pgQuery(`UPDATE face_people SET name=$2, updated_at=now() WHERE person_id=$1`, [
        person,
        name,
      ])
      return { personId: person, name }
    },
  )
}

export async function setHidden(id: string, hidden: boolean) {
  const person = personId(id)
  return correct(
    hidden ? 'hide' : 'unhide',
    hidden ? 'Hid a person' : 'Showed a person',
    { people: [person] },
    async () => {
      await pgQuery(`UPDATE face_people SET hidden=$2, updated_at=now() WHERE person_id=$1`, [
        person,
        hidden,
      ])
      return { personId: person, hidden }
    },
  )
}

export async function setCover(id: string, face: unknown) {
  const person = personId(id)
  const faceId = integer(face, 'face', 1, Number.MAX_SAFE_INTEGER)
  return correct('cover', 'Changed a cover photo', { people: [person] }, async () => {
    const ok = await pgQueryOne(
      `SELECT 1 FROM face_assignments a JOIN faces f USING(face_id)
       WHERE a.face_id=$1 AND a.person_id=$2 AND f.crop_path IS NOT NULL AND NOT f.ignored`,
      [faceId, person],
    )
    if (!ok) throw new HttpError(400, 'Choose one of this person’s faces')
    await pgQuery(`UPDATE face_people SET cover_face_id=$2, updated_at=now() WHERE person_id=$1`, [
      person,
      faceId,
    ])
    return { personId: person, coverFaceId: faceId }
  })
}

/** "Yes, this is them": confirms the person's matches among the given faces. */
export async function confirmFaces(id: string, faces: unknown) {
  const person = personId(id)
  const ids = faceIds(faces)
  return correct(
    'confirm',
    `Confirmed ${ids.length} face${ids.length === 1 ? '' : 's'}`,
    { faces: ids, people: [person] },
    async () => {
      const rows = await pgQuery(
        `UPDATE face_assignments SET status='confirmed', score=NULL WHERE person_id=$1 AND face_id=ANY($2::bigint[]) RETURNING face_id`,
        [person, ids],
      )
      if (rows.length !== ids.length)
        throw new HttpError(409, 'Some faces are no longer matched to this person')
      return { confirmed: rows.length }
    },
  )
}

/** "Not this person": removes the match and stops the scanner from suggesting it again. */
export async function rejectFaces(id: string, faces: unknown) {
  const person = personId(id)
  const ids = faceIds(faces)
  return correct(
    'reject',
    `Removed ${ids.length} face${ids.length === 1 ? '' : 's'} from a person`,
    { faces: ids, people: [person] },
    async () => {
      const rows = await pgQuery(
        `DELETE FROM face_assignments WHERE person_id=$1 AND face_id=ANY($2::bigint[]) RETURNING face_id`,
        [person, ids],
      )
      if (rows.length !== ids.length)
        throw new HttpError(409, 'Some faces are no longer matched to this person')
      await pgQuery(
        `INSERT INTO face_rejections(face_id,person_id,owner_username) SELECT unnest($2::bigint[]),$1,${OWNER} ON CONFLICT DO NOTHING`,
        [person, ids],
      )
      await refreshCovers([person])
      return { removed: rows.length }
    },
  )
}

/** Assigns faces (unknown, suggested, or someone else's) to a person or a name. */
export async function assignToPerson(body: Record<string, unknown>) {
  const ids = faceIds(body.faceIds)
  const people = body.personId != null ? [personId(body.personId)] : []
  return correct(
    'assign',
    `Tagged ${ids.length} face${ids.length === 1 ? '' : 's'}`,
    { faces: ids, people },
    async (state) => {
      const person = await target(state, body)
      await assignFaces(ids, person)
      const previous = state.assignments.map((a) => String(a.person_id)).filter((p) => p !== person)
      if (previous.length) await refreshCovers([...new Set(previous)])
      return { personId: person, assigned: ids.length }
    },
  )
}

/** Tags someone the scanner missed: a drawn box or a name-only tag on a photo. */
export async function tagPhoto(photo: unknown, body: Record<string, unknown>) {
  const photoId = integer(photo, 'photo')
  const box = faceBox(body.box)
  const people = body.personId != null ? [personId(body.personId)] : []
  return correct('assign', 'Tagged a person in a photo', { people }, async (state) => {
    const person = await target(state, body)
    // People belong to a photo's owner. A main admin can edit any album but tags only
    // their own photos: a face on another owner's photo could not join the admin's people.
    const face = await pgQueryOne<{ face_id: number }>(
      `INSERT INTO faces(photo_id,owner_username,source,box_x,box_y,box_w,box_h,created_by)
       SELECT $1,${OWNER},'manual',$2,$3,$4,$5,${OWNER}
       WHERE photo_security.photo_owner($1)=${OWNER} RETURNING face_id`,
      [photoId, box?.x ?? null, box?.y ?? null, box?.w ?? null, box?.h ?? null],
    ).catch((error) => {
      // Row security rejects photos the caller does not own or cannot edit.
      if ((error as { code?: string }).code === '42501') throw new HttpError(404, 'Photo not found')
      throw error
    })
    if (!face) throw new HttpError(404, 'Photo not found')
    state.createdFaces.push(Number(face!.face_id))
    await assignFaces([Number(face!.face_id)], person)
    return { personId: person, faceId: Number(face!.face_id) }
  })
}

/** Move entire groups without promoting suggestions or overriding rejected matches. */
async function mergeGroupAssignments(keep: string, absorb: string[]) {
  // Faces rejected for the kept person stay off it; their match is dropped.
  await pgQuery(
    `DELETE FROM face_assignments a WHERE a.person_id=ANY($2::uuid[])
   AND EXISTS(SELECT FROM face_rejections r WHERE r.face_id=a.face_id AND r.person_id=$1)`,
    [keep, absorb],
  )
  // Settled matches become confirmed (the scanner then leaves them alone); low-confidence
  // suggestions stay in Needs review.
  await pgQuery(
    `UPDATE face_assignments SET person_id=$1,
     status=CASE WHEN status='suggested' THEN status ELSE 'confirmed' END,
     score=CASE WHEN status='suggested' THEN score END
   WHERE person_id=ANY($2::uuid[]) OR (person_id=$1 AND status<>'suggested')`,
    [keep, absorb],
  )
  await pgQuery(
    `INSERT INTO face_rejections(face_id,person_id,owner_username)
   SELECT r.face_id,$1,r.owner_username FROM face_rejections r WHERE r.person_id=ANY($2::uuid[])
     AND NOT EXISTS(SELECT FROM face_assignments a WHERE a.face_id=r.face_id AND a.person_id=$1)
   ON CONFLICT DO NOTHING`,
    [keep, absorb],
  )
  await pgQuery(`DELETE FROM face_people WHERE person_id=ANY($1::uuid[])`, [absorb])
}

/** Merges people into one. Different names are refused, so no name is silently lost. */
export async function mergePeople(keepId: unknown, absorbIds: unknown) {
  let keep = personId(keepId)
  if (!Array.isArray(absorbIds) || !absorbIds.length || absorbIds.length > 50)
    throw new HttpError(400, 'Choose 1-50 people to merge')
  let absorb = [...new Set(absorbIds.map(personId))].filter((id) => id !== keep)
  if (!absorb.length) throw new HttpError(400, 'Choose someone else to merge')
  return correct(
    'merge',
    `Merged ${absorb.length + 1} people`,
    { people: [keep, ...absorb] },
    async (state) => {
      const named = state.people.filter(
        (p) => p.name && [keep, ...absorb].includes(String(p.person_id)),
      )
      const names = new Set(named.map((p) => String(p.name).toLowerCase()))
      if (names.size > 1)
        throw new HttpError(
          409,
          'These people have different names. Rename one so the names match, then merge.',
        )
      // The named identity (and its chosen cover) survives an unnamed-to-named merge,
      // including requests from older clients that send the unnamed group as keep.
      if (!state.people.find((p) => p.person_id === keep)?.name && named.length === 1) {
        const previousKeep = keep
        keep = personId(named[0].person_id)
        absorb = [previousKeep, ...absorb.filter((id) => id !== keep)]
      }
      await mergeGroupAssignments(keep, absorb)
      const name = named[0]?.name ?? null
      await pgQuery(`UPDATE face_people SET name=$2 WHERE person_id=$1`, [keep, name])
      await refreshCovers([keep])
      return { personId: keep, merged: absorb.length }
    },
  )
}

/** A paged picker cannot determine whether a typed name exists elsewhere.
 * Resolve it under the same owner lock as creation, preserving assign vs split
 * correction semantics without downloading the full people inventory. */
export async function movePersonFaces(id: string, faces: unknown, value: unknown) {
  const source = personId(id)
  const ids = faceIds(faces)
  const name = personName(value)
  return pgTransaction(async () => {
    await lockCorrections()
    const existing = await existingName(name)
    if (!existing) return splitPerson(source, ids, name)
    if (existing.hidden)
      throw new HttpError(409, 'Someone already has this name. Show or choose that person first.')
    if (existing.person_id === source) throw new HttpError(409, 'Choose a different person')
    return correct(
      'assign',
      `Moved ${ids.length} faces to ${name}`,
      { faces: ids, people: [source, existing.person_id] },
      async () => {
        const assigned = await pgQuery(
          'SELECT 1 FROM face_assignments WHERE person_id=$1 AND face_id=ANY($2::bigint[])',
          [source, ids],
        )
        if (assigned.length !== ids.length)
          throw new HttpError(409, 'Some faces are no longer matched to this person')
        await assignFaces(ids, existing.person_id)
        await refreshCovers([source])
        return { personId: existing.person_id, moved: ids.length }
      },
    )
  })
}

/** Moves faces out to a new person and keeps them off the original. */
export async function splitPerson(id: string, faces: unknown, name: unknown) {
  const person = personId(id)
  const ids = faceIds(faces)
  const newName = name == null || name === '' ? null : personName(name)
  return correct(
    'split',
    `Split ${ids.length} face${ids.length === 1 ? '' : 's'} into a new person`,
    { faces: ids, people: [person] },
    async (state) => {
      const owned = await pgQuery(
        `SELECT 1 FROM face_assignments WHERE person_id=$1 AND face_id=ANY($2::bigint[])`,
        [person, ids],
      )
      if (owned.length !== ids.length)
        throw new HttpError(409, 'Some faces are no longer matched to this person')
      const created = await createPerson(state, newName)
      await assignFaces(ids, created)
      await pgQuery(
        `INSERT INTO face_rejections(face_id,person_id,owner_username) SELECT unnest($2::bigint[]),$1,${OWNER} ON CONFLICT DO NOTHING`,
        [person, ids],
      )
      await pgQuery(
        `UPDATE face_assignments SET status='confirmed', score=NULL WHERE person_id=$1 AND status<>'suggested'`,
        [person],
      )
      await refreshCovers([person])
      return { personId: created, moved: ids.length }
    },
  )
}

/** One atomic, undoable decision for selected unnamed groups (including unloaded faces). */
export async function changeGroups(body: Record<string, unknown>) {
  if (!Array.isArray(body.groupIds) || !body.groupIds.length || body.groupIds.length > 200)
    throw new HttpError(400, 'Choose 1–200 groups')
  const groups = [...new Set(body.groupIds.map(personId))]
  if (body.action !== 'ignore' && body.action !== 'assign')
    throw new HttpError(400, 'Invalid group action')
  const assigning = body.action === 'assign'
  return pgTransaction(async () => {
    await lockCorrections()
    const name = assigning && body.personId == null ? personName(body.name) : null
    const existing = name ? await existingName(name) : null
    const destination =
      assigning && body.personId != null ? personId(body.personId) : existing?.person_id
    if (destination && groups.includes(destination))
      throw new HttpError(400, 'Choose a different target person')
    return correct(
      assigning ? 'merge' : 'ignore',
      `${assigning ? 'Assigned' : 'Ignored'} ${groups.length} groups`,
      { people: [...groups, ...(destination ? [destination] : [])] },
      async (state) => {
        if (state.people.some((p) => groups.includes(String(p.person_id)) && p.name != null))
          throw new HttpError(
            409,
            'A selected group has been named. Refresh Groups and select again.',
          )
        if (!assigning) {
          const rows = await pgQuery(
            `UPDATE faces SET ignored=true WHERE NOT ignored AND face_id IN
             (SELECT face_id FROM face_assignments WHERE person_id=ANY($1::uuid[])) RETURNING face_id`,
            [groups],
          )
          await refreshCovers(groups)
          return { groups: groups.length, faces: rows.length }
        }
        const keep = destination ?? (await createPerson(state, name!))
        await mergeGroupAssignments(keep, groups)
        await refreshCovers([keep])
        return { groups: groups.length, personId: keep }
      },
    )
  })
}

/** Ignore the entire group on the server, including faces beyond the loaded page. */
export async function ignorePerson(id: string) {
  const person = personId(id)
  return correct('ignore', 'Ignored all faces in a group', { people: [person] }, async () => {
    const rows = await pgQuery(
      `UPDATE faces SET ignored=true WHERE NOT ignored AND face_id IN
       (SELECT face_id FROM face_assignments WHERE person_id=$1) RETURNING face_id`,
      [person],
    )
    await refreshCovers([person])
    return { faces: rows.length, ignored: true }
  })
}

/** Ignored faces (strangers, posters) disappear from People and search; reversible. */
export async function setIgnored(faces: unknown, ignored: boolean) {
  const ids = faceIds(faces)
  const label = `${ignored ? 'Ignored' : 'Restored'} ${ids.length} face${ids.length === 1 ? '' : 's'}`
  return correct(ignored ? 'ignore' : 'unignore', label, { faces: ids }, async (state) => {
    await pgQuery(`UPDATE faces SET ignored=$2 WHERE face_id=ANY($1::bigint[])`, [ids, ignored])
    const people = [...new Set(state.assignments.map((a) => String(a.person_id)))]
    if (people.length) await refreshCovers(people)
    return { faces: ids.length, ignored }
  })
}
