import { peopleWrite } from '@/lib/people/people-api'
import { changeGroups } from '@/lib/people'

export const dynamic = 'force-dynamic'
export const POST = peopleWrite('groups', (body) => changeGroups(body))
