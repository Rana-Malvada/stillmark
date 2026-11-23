import { peopleRead } from '@/lib/people/people-api'
import { peopleOptions } from '@/lib/people/people-options'

export const dynamic = 'force-dynamic'
export const GET = peopleRead((req) => {
  const params = new URL(req.url).searchParams
  return peopleOptions(
    params.get('q') ?? '',
    params.get('cursor'),
    params.get('details') === 'true',
  )
})
