import { peopleWrite } from '@/lib/people/people-api'
import { setIgnored } from '@/lib/people'
import { HttpError } from '@/lib/http'

export const dynamic = 'force-dynamic'

export const POST = peopleWrite(
  (body) => (body.ignored === false ? 'unignore' : 'ignore'),
  (body) => {
    if (typeof body.ignored !== 'boolean') throw new HttpError(400, 'Invalid ignored')
    return setIgnored(body.faceIds, body.ignored)
  },
)
