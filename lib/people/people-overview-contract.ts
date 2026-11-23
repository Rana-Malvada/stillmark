import type { Person } from './people-types'
import { peopleApi } from './people-client'

export interface PeopleOverview {
  named: Person[]
  unnamed: Person[]
  hidden: Person[]
  reviewCount: number
  lowerConfidenceCount: number
  unknownCount: number
  ignoredCount: number
  unnamedCount: number
  peopleCount: number
  nextCursor?: string | null
  more?: boolean
}
type WirePerson = Omit<Person, 'coverFaceId'> & { coverFaceId: number | string | null }
type TotalKey =
  | 'reviewCount'
  | 'lowerConfidenceCount'
  | 'unknownCount'
  | 'ignoredCount'
  | 'unnamedCount'
  | 'peopleCount'
type PeoplePage = Omit<PeopleOverview, TotalKey> & Partial<Pick<PeopleOverview, TotalKey>>
type WireOverview = Omit<PeoplePage, 'named' | 'unnamed' | 'hidden'> & {
  named: WirePerson[]
  unnamed: WirePerson[]
  hidden: WirePerson[]
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const faceId = (v: unknown) =>
  v === null ||
  ((typeof v === 'number' || (typeof v === 'string' && /^[1-9]\d*$/.test(v))) &&
    Number.isSafeInteger(Number(v)) &&
    Number(v) > 0)
export function isPeopleOverview(value: unknown): value is WireOverview {
  if (!record(value)) return false
  return (
    ['named', 'unnamed', 'hidden'].every(
      (key) =>
        Array.isArray(value[key]) &&
        value[key].every(
          (p: unknown) =>
            record(p) &&
            typeof p.personId === 'string' &&
            (p.name === null || typeof p.name === 'string') &&
            typeof p.hidden === 'boolean' &&
            faceId(p.coverFaceId) &&
            count(p.photoCount) &&
            count(p.reviewCount),
        ),
    ) &&
    [
      'reviewCount',
      'lowerConfidenceCount',
      'unknownCount',
      'ignoredCount',
      'unnamedCount',
      'peopleCount',
    ].every((key) => value[key] === undefined || count(value[key])) &&
    (value.more === undefined || typeof value.more === 'boolean') &&
    (value.nextCursor === undefined ||
      value.nextCursor === null ||
      (typeof value.nextCursor === 'string' && value.nextCursor.length > 0))
  )
}
const totalKeys: TotalKey[] = [
  'reviewCount',
  'lowerConfidenceCount',
  'unknownCount',
  'ignoredCount',
  'unnamedCount',
  'peopleCount',
]
export function loadPeopleOverview(url: string, signal?: AbortSignal): Promise<PeopleOverview>
export function loadPeopleOverview(
  url: string,
  signal: AbortSignal | undefined,
  includeTotals: false,
): Promise<PeoplePage>
export async function loadPeopleOverview(
  url: string,
  signal?: AbortSignal,
  includeTotals = true,
): Promise<PeoplePage> {
  const validate = (value: unknown): value is WireOverview =>
    isPeopleOverview(value) && (!includeTotals || totalKeys.every((key) => count(value[key])))
  const value = await peopleApi(url, 'GET', undefined, signal, validate)
  const normalize = (people: WirePerson[]) =>
    people.map((p) => ({
      ...p,
      coverFaceId: p.coverFaceId === null ? null : Number(p.coverFaceId),
    }))
  return {
    ...value,
    named: normalize(value.named),
    unnamed: normalize(value.unnamed),
    hidden: normalize(value.hidden),
  }
}
export function isPeopleSettings(
  value: unknown,
): value is { enabled: boolean; shareNames: boolean } {
  return (
    record(value) && typeof value.enabled === 'boolean' && typeof value.shareNames === 'boolean'
  )
}
