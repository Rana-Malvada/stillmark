import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadPeopleHistory } from '@/components/people/history-loader'
import { types } from 'pg'

const fetchMock = vi.fn()
const row = {
  id: '7',
  kind: 'rename',
  summary: 'Named Alice',
  createdAt: '2026-11-08T12:00:00.000Z',
  undoneAt: null,
  canUndo: true,
}
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

it('accepts an empty history array', async () => {
  fetchMock.mockResolvedValueOnce(Response.json([]))
  expect(await loadPeopleHistory()).toEqual([])
})
it('normalizes PostgreSQL BIGINT history IDs before the Undo UI uses them', async () => {
  fetchMock.mockResolvedValueOnce(Response.json([row]))
  expect(await loadPeopleHistory()).toEqual([{ ...row, id: 7 }])
})
it('rejects malformed history bodies so the UI can offer Retry', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ error: 'unexpected body' }))
  await expect(loadPeopleHistory()).rejects.toMatchObject({ status: 200 })
})

it('accepts the JSON representation of pg BIGINT and timestamptz columns', async () => {
  const bigint = types.getTypeParser(20)
  const date = types.getTypeParser(1184)
  fetchMock.mockResolvedValueOnce(
    Response.json([
      {
        ...row,
        id: bigint('7'),
        createdAt: date('2026-11-08 12:00:00+00'),
        undoneAt: date('2026-11-08 13:00:00+00'),
      },
    ]),
  )
  expect(await loadPeopleHistory()).toMatchObject([
    { id: 7, createdAt: '2026-11-08T12:00:00.000Z', undoneAt: '2026-11-08T13:00:00.000Z' },
  ])
})

it.each([
  null,
  {},
  { items: [] },
  [null],
  [{ ...row, id: '01' }],
  [{ ...row, id: '9007199254740992' }],
  [{ ...row, id: -1 }],
  [{ ...row, id: 1.2 }],
  [{ ...row, summary: {} }],
  [{ ...row, createdAt: 'yesterday' }],
  [{ ...row, createdAt: 0 }],
  [{ ...row, undoneAt: false }],
  [{ ...row, canUndo: 'true' }],
])('rejects malformed history values before rendering: %j', async (body) => {
  fetchMock.mockResolvedValueOnce(Response.json(body))
  await expect(loadPeopleHistory()).rejects.toMatchObject({ status: 200 })
})

it.each([
  () => new Response('<h1>Unavailable</h1>', { status: 502 }),
  () => new Response('{broken', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  () => Promise.reject(new TypeError('Failed to fetch')),
])('can load history successfully after a failed attempt', async (failure) => {
  fetchMock.mockImplementationOnce(failure).mockResolvedValueOnce(Response.json([row]))
  await expect(loadPeopleHistory()).rejects.toBeInstanceOf(Error)
  expect(await loadPeopleHistory()).toMatchObject([{ id: 7, summary: 'Named Alice' }])
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('rejects a late response after cancellation even when the transport ignored the signal', async () => {
  let resolve!: (response: Response) => void
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const request = new AbortController()
  const pending = loadPeopleHistory(request.signal)
  const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  request.abort()
  resolve(Response.json([row]))
  await result
})
