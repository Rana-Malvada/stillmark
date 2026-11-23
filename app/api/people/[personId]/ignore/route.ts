import { peopleWrite } from '@/lib/people/people-api'
import { ignorePerson } from '@/lib/people'

export const dynamic = 'force-dynamic'
export const POST = peopleWrite('ignore', (_body, { personId }) => ignorePerson(personId))
