import { peopleRead } from '@/lib/people/people-api'
import { history } from '@/lib/people'

export const dynamic = 'force-dynamic'

export const GET = peopleRead(() => history())
