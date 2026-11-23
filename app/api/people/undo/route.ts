import { peopleWrite } from '@/lib/people/people-api'
import { undo } from '@/lib/people'

export const dynamic = 'force-dynamic'

export const POST = peopleWrite('undo', (body) => undo(body.id))
