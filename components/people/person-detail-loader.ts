import { ClientResponseError } from '@/lib/client-response'
import { peopleApi } from '@/lib/people/people-client'
import type { Face, Person } from './shared'

export interface PersonFacePage {
  faces: Face[]
  more: boolean
  nextCursor?: string | null
}
interface PersonPage extends PersonFacePage {
  person: Person
}
type WireFace = Omit<Face, 'faceId'> & { faceId: number | string }
interface WireFacePage extends Omit<PersonFacePage, 'faces'> {
  faces: WireFace[]
}
interface WirePersonPage extends WireFacePage {
  person: Omit<Person, 'coverFaceId'> & { coverFaceId: number | string | null }
}
export type PersonDetailResult =
  ({ status: 'ready' } & PersonPage) | { status: 'missing' } | { status: 'error'; message: string }

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
// node-postgres returns BIGINT columns as decimal strings. The UI uses numeric IDs,
// so accept only canonical values which can be represented without precision loss.
const bigintId = (value: unknown): value is number | string =>
  id(value) || (typeof value === 'string' && /^[1-9]\d*$/.test(value) && id(Number(value)))
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
const nullableString = (value: unknown) => value === null || typeof value === 'string'

function isFace(value: unknown): value is WireFace {
  return (
    record(value) &&
    bigintId(value.faceId) &&
    id(value.photoId) &&
    typeof value.hasCrop === 'boolean' &&
    (value.eventId === undefined || id(value.eventId)) &&
    (value.thumbnailPath === undefined || nullableString(value.thumbnailPath)) &&
    (value.qualityOk === undefined || typeof value.qualityOk === 'boolean') &&
    (value.status === undefined ||
      value.status === null ||
      (typeof value.status === 'string' &&
        ['suggested', 'auto', 'confirmed'].includes(value.status))) &&
    (value.score === undefined ||
      value.score === null ||
      (typeof value.score === 'number' && Number.isFinite(value.score))) &&
    (value.source === undefined || value.source === 'detected' || value.source === 'manual') &&
    (value.personId === undefined || nullableString(value.personId)) &&
    (value.personName === undefined || nullableString(value.personName))
  )
}
export function isPersonFacePage(value: unknown): value is WireFacePage {
  return (
    record(value) &&
    Array.isArray(value.faces) &&
    value.faces.every(isFace) &&
    typeof value.more === 'boolean' &&
    (value.nextCursor === undefined ||
      value.nextCursor === null ||
      (typeof value.nextCursor === 'string' && value.nextCursor.length > 0))
  )
}
function isPersonPage(value: unknown, personId: string): value is WirePersonPage {
  if (!isPersonFacePage(value) || !record(value)) return false
  const person = value.person
  return (
    record(person) &&
    person.personId === personId.trim().toLowerCase() &&
    nullableString(person.name) &&
    typeof person.hidden === 'boolean' &&
    (person.coverFaceId === null || bigintId(person.coverFaceId)) &&
    count(person.photoCount) &&
    count(person.reviewCount)
  )
}

export function normalizeFacePage(page: WireFacePage): PersonFacePage {
  return {
    faces: page.faces.map((face) => ({ ...face, faceId: Number(face.faceId) })),
    more: page.more,
    nextCursor: page.nextCursor,
  }
}

export async function loadPersonFacePage(
  personId: string,
  offset: number,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<PersonFacePage> {
  const page = await peopleApi<WireFacePage>(
    `/api/people/${personId.trim().toLowerCase()}?summary=false&${cursor ? `cursor=${encodeURIComponent(cursor)}` : `offset=${offset}`}`,
    'GET',
    undefined,
    signal,
    isPersonFacePage,
  )
  signal?.throwIfAborted()
  if (page.more && cursor && page.nextCursor === cursor)
    throw new ClientResponseError('Could not load more faces. Try again.', 200)
  return normalizeFacePage(page)
}

/** A failed read is replaceable state. Only an actual HTTP 404 means a removed person. */
export async function loadPersonDetail(
  personId: string,
  target: number,
  signal: AbortSignal,
): Promise<PersonDetailResult> {
  try {
    const raw = await peopleApi<WirePersonPage>(
      `/api/people/${personId.trim().toLowerCase()}`,
      'GET',
      undefined,
      signal,
      (value): value is WirePersonPage => isPersonPage(value, personId),
    )
    signal.throwIfAborted()
    const page: PersonPage = {
      ...normalizeFacePage(raw),
      person: {
        ...raw.person,
        coverFaceId: raw.person.coverFaceId === null ? null : Number(raw.person.coverFaceId),
      },
    }
    const seenCursors = new Set<string>()
    while (page.more && page.faces.length < target) {
      if (page.nextCursor) {
        if (seenCursors.has(page.nextCursor)) throw new Error('Could not load faces. Try again.')
        seenCursors.add(page.nextCursor)
      }
      const next = await loadPersonFacePage(personId, page.faces.length, page.nextCursor, signal)
      const seen = new Set(page.faces.map((face) => face.faceId))
      const added = next.faces.filter((face) => !seen.has(face.faceId))
      page.faces.push(...added)
      page.more = next.more && added.length > 0
      page.nextCursor = next.nextCursor
    }
    return { ...page, status: 'ready' }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ClientResponseError && error.status === 404) return { status: 'missing' }
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Could not load this person. Try again.',
    }
  }
}
