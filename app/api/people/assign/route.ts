import { peopleWrite } from '@/lib/people/people-api'
import { assignToPerson } from '@/lib/people'

export const dynamic = 'force-dynamic'

export const POST = peopleWrite('assign', (body) => assignToPerson(body))
