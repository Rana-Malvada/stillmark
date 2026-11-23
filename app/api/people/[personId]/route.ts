import { peopleRead, peopleWrite } from '@/lib/people/people-api'
import { getPerson, renamePerson, setCover, setHidden } from '@/lib/people'
import { HttpError } from '@/lib/http'

export const dynamic = 'force-dynamic'

export const GET = peopleRead((req, { personId }) =>
  getPerson(
    personId,
    new URL(req.url).searchParams.get('offset'),
    new URL(req.url).searchParams.get('cursor'),
    new URL(req.url).searchParams.get('summary') !== 'false',
  ),
)

/** One change per request: `name`, `hidden`, or `coverFaceId`. */
export const PATCH = peopleWrite(
  (body) => ('name' in body ? 'rename' : 'hidden' in body ? 'hide' : 'cover'),
  (body, { personId }) => {
    const keys = ['name', 'hidden', 'coverFaceId'].filter((k) => k in body)
    if (keys.length !== 1) throw new HttpError(400, 'Change one of name, hidden or coverFaceId')
    if ('name' in body) return renamePerson(personId, body.name)
    if ('hidden' in body) {
      if (typeof body.hidden !== 'boolean') throw new HttpError(400, 'Invalid hidden')
      return setHidden(personId, body.hidden)
    }
    return setCover(personId, body.coverFaceId)
  },
)
