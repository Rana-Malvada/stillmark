import { peopleRead, peopleWrite } from '@/lib/people/people-api'
import { deleteFaceData, getSettings, updateSettings } from '@/lib/people'

export const dynamic = 'force-dynamic'

export const GET = peopleRead(() => getSettings())
export const PATCH = peopleWrite('settings', (body) => updateSettings(body))
/** Deletes all of the caller's face data and turns People off. */
export const DELETE = peopleWrite('delete_data', () => deleteFaceData(), { body: false })
