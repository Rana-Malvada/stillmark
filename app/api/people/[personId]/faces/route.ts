import { peopleWrite } from '@/lib/people/people-api'
import { confirmFaces, movePersonFaces, rejectFaces, splitPerson } from '@/lib/people'
import { HttpError } from '@/lib/http'

export const dynamic = 'force-dynamic'

const ACTIONS = ['confirm', 'reject', 'split', 'move']

/** Decisions about some of a person's faces: confirm, "Not this person", or split off. */
export const POST = peopleWrite(
  (body) => String(body.action),
  (body, { personId }) => {
    if (!ACTIONS.includes(String(body.action))) throw new HttpError(400, 'Invalid action')
    if (body.action === 'confirm') return confirmFaces(personId, body.faceIds)
    if (body.action === 'reject') return rejectFaces(personId, body.faceIds)
    if (body.action === 'move') return movePersonFaces(personId, body.faceIds, body.name)
    return splitPerson(personId, body.faceIds, body.name)
  },
)
