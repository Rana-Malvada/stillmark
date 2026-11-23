import { peopleRead } from '@/lib/people/people-api'
import { unknownFaces } from '@/lib/people'

export const dynamic = 'force-dynamic'

export const GET = peopleRead((req) => {
  const params = new URL(req.url).searchParams
  return unknownFaces(
    params.get('offset'),
    params.get('ignored') === '1',
    params.get('quality') ?? 'all',
    params.get('cursor'),
  )
})
