import { peopleRead } from '@/lib/people/people-api'
import { reviewQueue } from '@/lib/people'

export const dynamic = 'force-dynamic'

export const GET = peopleRead((req) =>
  reviewQueue(
    new URL(req.url).searchParams.get('offset'),
    new URL(req.url).searchParams.get('cursor'),
  ),
)
