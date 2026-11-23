import type { AlbumPlace } from './albums/album-location'
import type { ReportRow } from './costs/daily-chart'

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const string = (v: unknown): v is string => typeof v === 'string'
const nullableString = (v: unknown) => v === null || string(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const id = (v: unknown) => count(v) && Number(v) > 0
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v)
export const isOk = (v: unknown): v is { ok: true } => isRecord(v) && v.ok === true
export const isCount = (v: unknown): v is { count: number } => isRecord(v) && count(v.count)
export const isLabels = (v: unknown): v is { caption: string | null; tags: string[] } =>
  isRecord(v) && nullableString(v.caption) && Array.isArray(v.tags) && v.tags.every(string)
export interface SearchPhoto {
  photoId: number
  eventId: number
  sourceFilename: string
  thumbnailUrl?: string | null
  aiDescription: string | null
  caption: string | null
}
export interface SearchAlbum {
  eventId: number
  eventName: string
  eventMonth: number | null
  eventYear: number | null
  location: string | null
  photoCount: number
  coverUrl: string | null
}
export interface SearchPerson {
  personId: string
  name: string
}
export interface SearchSuggestion extends SearchPerson {
  coverFaceId: number | null
  photoCount: number
  query?: string
}
export interface SearchPage<T> {
  results: T[]
  source: string
  count: number
  candidateCount?: number
  nextCursor?: string | null
  ranking?: string
  countIsExact?: boolean
  countIsLowerBound?: boolean
  relatedAvailable?: boolean
  clarification?: string | null
  notice?: string | null
  interpretation?: {
    elapsedMs: number
    inputTokens: number | null
    outputTokens: number | null
  } | null
  people?: SearchPerson[]
  suggestions?: SearchSuggestion[]
}
const person = (v: unknown) => isRecord(v) && string(v.personId) && string(v.name)
const photo = (v: unknown) =>
  isRecord(v) &&
  id(v.photoId) &&
  id(v.eventId) &&
  string(v.sourceFilename) &&
  nullableString(v.aiDescription) &&
  nullableString(v.caption) &&
  optional(v.thumbnailUrl, nullableString)
const album = (v: unknown) =>
  isRecord(v) &&
  id(v.eventId) &&
  string(v.eventName) &&
  (v.eventMonth === null || (id(v.eventMonth) && Number(v.eventMonth) <= 12)) &&
  (v.eventYear === null || id(v.eventYear)) &&
  nullableString(v.location) &&
  count(v.photoCount) &&
  nullableString(v.coverUrl)
function searchPage<T extends SearchPhoto | SearchAlbum>(albums: boolean) {
  return (v: unknown): v is SearchPage<T> =>
    isRecord(v) &&
    Array.isArray(v.results) &&
    v.results.every(albums ? album : photo) &&
    string(v.source) &&
    count(v.count) &&
    optional(v.candidateCount, count) &&
    optional(v.nextCursor, nullableString) &&
    optional(v.ranking, string) &&
    ['countIsExact', 'countIsLowerBound', 'relatedAvailable'].every((k) =>
      optional(v[k], (x) => typeof x === 'boolean'),
    ) &&
    optional(v.clarification, nullableString) &&
    optional(v.notice, nullableString) &&
    optional(v.people, (x) => Array.isArray(x) && x.every(person)) &&
    optional(
      v.suggestions,
      (x) =>
        Array.isArray(x) &&
        x.every(
          (s) =>
            person(s) &&
            isRecord(s) &&
            (s.coverFaceId === null || id(s.coverFaceId)) &&
            count(s.photoCount) &&
            optional(s.query, string),
        ),
    ) &&
    optional(
      v.interpretation,
      (x) =>
        x === null ||
        (isRecord(x) &&
          finite(x.elapsedMs) &&
          (x.inputTokens === null || count(x.inputTokens)) &&
          (x.outputTokens === null || count(x.outputTokens))),
    )
}
export interface TrashItem {
  photoId: number
  filename: string
  albumName: string
  expiresAt: string
}
export interface TrashPage {
  files: TrashItem[]
  hasMore: boolean
}
export const isTrashPage = (v: unknown): v is TrashPage =>
  isRecord(v) &&
  typeof v.hasMore === 'boolean' &&
  Array.isArray(v.files) &&
  v.files.every(
    (x) =>
      isRecord(x) &&
      id(x.photoId) &&
      string(x.filename) &&
      string(x.albumName) &&
      string(x.expiresAt),
  )
export interface LocationStatus {
  eligible: number
  changes: { id: string; label: string; applied_by: string; applied_at: string; count: number }[]
}
export const isLocationStatus = (v: unknown): v is LocationStatus =>
  isRecord(v) &&
  count(v.eligible) &&
  Array.isArray(v.changes) &&
  v.changes.every(
    (x) =>
      isRecord(x) &&
      ['id', 'label', 'applied_by', 'applied_at'].every((k) => string(x[k])) &&
      count(x.count),
  )
export const isPlaces = (v: unknown): v is { places: AlbumPlace[] } =>
  isRecord(v) &&
  Array.isArray(v.places) &&
  v.places.every(
    (x) =>
      isRecord(x) &&
      string(x.label) &&
      finite(x.lat) &&
      Math.abs(x.lat) <= 90 &&
      finite(x.lng) &&
      Math.abs(x.lng) <= 180 &&
      ['city', 'region', 'country'].every((k) => nullableString(x[k])),
  )
export const isAllowances = (v: unknown): v is { uploads: number; bytes: number } =>
  isRecord(v) && count(v.uploads) && count(v.bytes)
export interface CostSection {
  key: string
  label: string
  rows: ReportRow[]
  error: string | null
  stale?: boolean
  lastSuccessAt?: string
}
export interface AdminCostData {
  storage: { active_bytes: string; trash_bytes: string; media_count: number }
  snapshots: { day: string; active_bytes: string; trash_bytes: string; sampled_at: string }[]
  report: {
    refreshed_at: string | null
    payload: {
      asOf?: string
      timeZone?: string
      days?: number
      window?: string
      sections?: CostSection[]
    }
  } | null
}
const bytes = (v: unknown) => string(v) && /^\d+$/.test(v)
const row = (v: unknown) =>
  isRecord(v) && Object.values(v).every((x) => x === null || string(x) || finite(x))
export const isAdminCostData = (v: unknown): v is AdminCostData =>
  isRecord(v) &&
  isRecord(v.storage) &&
  bytes(v.storage.active_bytes) &&
  bytes(v.storage.trash_bytes) &&
  count(v.storage.media_count) &&
  Array.isArray(v.snapshots) &&
  v.snapshots.every(
    (s) =>
      isRecord(s) &&
      string(s.day) &&
      bytes(s.active_bytes) &&
      bytes(s.trash_bytes) &&
      string(s.sampled_at),
  ) &&
  (v.report === null ||
    (isRecord(v.report) &&
      nullableString(v.report.refreshed_at) &&
      isRecord(v.report.payload) &&
      optional(v.report.payload.asOf, string) &&
      optional(v.report.payload.timeZone, string) &&
      optional(v.report.payload.days, count) &&
      optional(v.report.payload.window, string) &&
      optional(
        v.report.payload.sections,
        (s) =>
          Array.isArray(s) &&
          s.every(
            (x) =>
              isRecord(x) &&
              string(x.key) &&
              string(x.label) &&
              nullableString(x.error) &&
              Array.isArray(x.rows) &&
              x.rows.every(row) &&
              optional(x.stale, (b) => typeof b === 'boolean') &&
              optional(x.lastSuccessAt, string),
          ),
      )))

export const isPhotoSearchPage = searchPage<SearchPhoto>(false)
export const isAlbumSearchPage = searchPage<SearchAlbum>(true)
export const isAnalysisStart = (v: unknown): v is { id: string; status: 'queued' | 'running' } =>
  isRecord(v) && string(v.id) && (v.status === 'queued' || v.status === 'running')
export const isReviewPhotos = (v: unknown): v is import('./upload/upload-review').ReviewPhoto[] =>
  Array.isArray(v) &&
  v.every(
    (x) =>
      isRecord(x) &&
      id(x.photoId) &&
      string(x.sourceFilename) &&
      nullableString(x.dateTaken) &&
      (x.latitude === null || finite(x.latitude)) &&
      (x.longitude === null || finite(x.longitude)),
  )
