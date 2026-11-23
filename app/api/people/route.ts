import { requirePagedList } from '@/lib/albums/bounded-list-api'
import { peopleRead } from '@/lib/people/people-api'
import { listPeople } from '@/lib/people'

export const dynamic = 'force-dynamic'

export const GET = peopleRead((req) => {
  const params = new URL(req.url).searchParams
  requirePagedList(params)
  return listPeople({
    kind: params.get('kind') ?? 'all',
    cursor: params.get('cursor'),
    includeTotals: params.get('summary') !== 'false',
  })
})
