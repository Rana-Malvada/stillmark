import { fetchBrowse } from '@/lib/fetch-browse'
import { readClientResponse } from '@/lib/client-response'

export interface EventData {
  ownerDisplayName?: string | null
  archivedAccount?: boolean
  visibility: string
  ownerUsername: string
  eventId: number
  sortOrder: number
  eventName: string
  eventMonth: number | null
  eventYear: number | null
  photoCount: number
  coverUrl: string | null
  location: string | null
  folderId: number | null
}

export interface FolderData {
  expanded?: boolean
  ownerDisplayName?: string | null
  ownerUsername?: string | null
  canSelect?: boolean
  canEdit?: boolean
  folderId: number
  folderName: string
  sortOrder: number
}

export interface EventGroup {
  section: string
  folder_id: number | null
  albums: number
  photos: number
}
export interface EventPage {
  items: EventData[]
  groups?: EventGroup[]
  nextCursor?: string | null
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const id = (v: unknown) => count(v) && Number(v) > 0
const text = (v: unknown) => typeof v === 'string'
const optionalText = (v: unknown) => v == null || text(v)
const optionalBoolean = (v: unknown) => v === undefined || typeof v === 'boolean'
function isEvent(v: unknown): v is EventData {
  return (
    record(v) &&
    id(v.eventId) &&
    Number.isSafeInteger(v.sortOrder) &&
    text(v.eventName) &&
    text(v.visibility) &&
    text(v.ownerUsername) &&
    optionalText(v.ownerDisplayName) &&
    optionalBoolean(v.archivedAccount) &&
    count(v.photoCount) &&
    (v.eventMonth == null ||
      (count(v.eventMonth) && Number(v.eventMonth) >= 1 && Number(v.eventMonth) <= 12)) &&
    (v.eventYear == null || count(v.eventYear)) &&
    (v.folderId == null || id(v.folderId)) &&
    optionalText(v.coverUrl) &&
    optionalText(v.location)
  )
}
export function isEventPage(v: unknown, requireGroups = false): v is EventPage {
  return (
    record(v) &&
    Array.isArray(v.items) &&
    v.items.every(isEvent) &&
    (v.nextCursor == null || (text(v.nextCursor) && v.nextCursor.length > 0)) &&
    ((!requireGroups && v.groups === undefined) ||
      (Array.isArray(v.groups) &&
        v.groups.every(
          (group) =>
            record(group) &&
            text(group.section) &&
            (group.folder_id === null || id(group.folder_id)) &&
            count(group.albums) &&
            count(group.photos),
        )))
  )
}
export function isEventFolders(v: unknown): v is FolderData[] {
  return (
    Array.isArray(v) &&
    v.every(
      (f) =>
        record(f) &&
        id(f.folderId) &&
        text(f.folderName) &&
        Number.isSafeInteger(f.sortOrder) &&
        optionalText(f.ownerUsername) &&
        optionalText(f.ownerDisplayName) &&
        optionalBoolean(f.expanded) &&
        optionalBoolean(f.canSelect) &&
        optionalBoolean(f.canEdit),
    )
  )
}
export async function loadEventPage(url: string, signal?: AbortSignal, requireGroups = false) {
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45000)])
  const page = await readClientResponse(
    await fetchBrowse(url, { signal: bounded }),
    'Unable to load albums. Please try again.',
    (v): v is EventPage => isEventPage(v, requireGroups),
  )
  bounded.throwIfAborted()
  return page
}
export async function loadEventFolders(signal: AbortSignal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(45000)])
  const folders = await readClientResponse(
    await fetch('/api/folders', { signal: bounded }),
    'Unable to load folders. Please try again.',
    isEventFolders,
  )
  bounded.throwIfAborted()
  return folders
}
/** Keep cursor creation beside the response contract used by initial and restored pages. */
export function eventPageUrl(
  mine: boolean,
  section: string,
  folderId: number | null,
  loaded: EventData[],
) {
  const last = [...loaded].sort((a, b) => a.sortOrder - b.sortOrder || a.eventId - b.eventId).at(-1)
  const params = new URLSearchParams({
    paged: 'true',
    scope: mine ? 'mine' : 'accessible',
    section,
    folder: folderId === null ? 'none' : String(folderId),
  })
  if (last)
    params.set(
      'cursor',
      btoa(JSON.stringify([last.sortOrder, last.eventId]))
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_'),
    )
  return `/api/events?${params}`
}
