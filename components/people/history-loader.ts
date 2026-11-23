import { peopleApi } from './shared'

export interface HistoryItem {
  id: number
  summary: string
  createdAt: string
  undoneAt: string | null
  canUndo: boolean
}
type WireHistoryItem = Omit<HistoryItem, 'id'> & { id: number | string }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value))
function isHistory(value: unknown): value is WireHistoryItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        record(item) &&
        (id(item.id) ||
          (typeof item.id === 'string' && /^[1-9]\d*$/.test(item.id) && id(Number(item.id)))) &&
        typeof item.summary === 'string' &&
        timestamp(item.createdAt) &&
        (item.undoneAt === null || timestamp(item.undoneAt)) &&
        typeof item.canUndo === 'boolean',
    )
  )
}

/** History is the People array endpoint; validate it explicitly and normalize pg BIGINT IDs. */
export async function loadPeopleHistory(signal?: AbortSignal): Promise<HistoryItem[]> {
  const items = await peopleApi<WireHistoryItem[]>(
    '/api/people/history',
    'GET',
    undefined,
    signal,
    isHistory,
  )
  signal?.throwIfAborted()
  return items.map((item) => ({ ...item, id: Number(item.id) }))
}
