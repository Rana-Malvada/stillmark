import type { PeopleOptionsPage } from './people-options'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveId = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0

/** Validate before options reach a React state updater or a selected-person control. */
export function isPeopleOptionsPage(value: unknown, details = false): value is PeopleOptionsPage {
  if (!record(value) || !Array.isArray(value.people) || value.people.length > 50) return false
  if (!(
    value.nextCursor === null ||
    (typeof value.nextCursor === 'string' && value.nextCursor.length > 0)
  ))
    return false
  return value.people.every(
    (person) =>
      record(person) &&
      typeof person.personId === 'string' &&
      person.personId.length > 0 &&
      typeof person.name === 'string' &&
      person.name.trim().length > 0 &&
      (!details || ('coverFaceId' in person && 'photoCount' in person)) &&
      (person.coverFaceId === undefined ||
        person.coverFaceId === null ||
        positiveId(person.coverFaceId)) &&
      (person.photoCount === undefined ||
        (Number.isSafeInteger(person.photoCount) && Number(person.photoCount) >= 0)),
  )
}
