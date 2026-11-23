import { peopleWrite } from '@/lib/people/people-api'
import { mergePeople } from '@/lib/people'

export const dynamic = 'force-dynamic'

export const POST = peopleWrite('merge', (body) => mergePeople(body.keep, body.absorb))
