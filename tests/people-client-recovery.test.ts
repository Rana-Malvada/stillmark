import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadPersonDetail, loadPersonFacePage } from '@/components/people/person-detail-loader'
import { peopleApi } from '@/components/people/shared'
import { ClientResponseError } from '@/lib/client-response'
import { types } from 'pg'

const fetchMock = vi.fn()
const personId = '22222222-2222-4222-8222-222222222222'
const otherId = '33333333-3333-4333-8333-333333333333'
const person = {
  personId,
  name: 'Alice',
  hidden: false,
  coverFaceId: 1,
  photoCount: 1,
  reviewCount: 0,
}
const face = {
  faceId: 1,
  photoId: 2,
  eventId: 3,
  thumbnailPath: null,
  hasCrop: true,
  source: 'detected',
}
const page = { person, faces: [face], more: false, nextCursor: null }
const signal = () => new AbortController().signal
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

it.each([
  () => new Response('<html>upstream timeout</html>', { status: 504 }),
  () => Response.json({ error: 'Try later', code: 'busy' }, { status: 503 }),
  () => Promise.reject(new TypeError('Failed to fetch')),
  () => Response.json({ ...page, person: null }),
])(
  'allows retry to replace a temporary initial failure with the loaded person',
  async (failure) => {
    fetchMock.mockImplementationOnce(failure).mockResolvedValueOnce(Response.json(page))
    let result = await loadPersonDetail(personId, 200, signal())
    expect(result.status).toBe('error')
    result = await loadPersonDetail(personId, 200, signal())
    expect(result).toMatchObject({ status: 'ready', person, faces: [face] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  },
)

it('only identifies an HTTP 404 as a missing person, and a later success clears it', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ error: 'Person not found' }, { status: 404 }))
  expect(await loadPersonDetail(personId, 200, signal())).toEqual({ status: 'missing' })
  for (const status of [401, 403, 429, 500]) {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status }))
    expect(await loadPersonDetail(personId, 200, signal())).toMatchObject({ status: 'error' })
  }
  fetchMock.mockResolvedValueOnce(Response.json(page))
  expect(await loadPersonDetail(personId, 200, signal())).toMatchObject({ status: 'ready' })
})

it.each([
  {},
  null,
  [],
  { ...page, faces: {} },
  { ...page, more: 'false' },
  { ...page, faces: [{ ...face, faceId: '1x' }] },
  { ...page, faces: [{ ...face, hasCrop: 'yes' }] },
  { ...page, faces: [{ ...face, status: ['confirmed'] }] },
  { ...page, person: { ...person, reviewCount: '1' } },
  { ...page, person: { ...person, personId: otherId } },
  { ...page, nextCursor: {} },
])(
  'rejects malformed successful person/face responses before the UI receives data: %j',
  async (badPage) => {
    fetchMock.mockResolvedValueOnce(Response.json(badPage))
    expect(await loadPersonDetail(personId, 200, signal())).toMatchObject({ status: 'error' })
  },
)

it('normalizes real node-postgres BIGINT fields on both summary and subsequent pages', async () => {
  // face_id/cover_face_id are BIGINT; counts are explicitly ::int and score is REAL.
  const bigint = types.getTypeParser(20)
  const int = types.getTypeParser(23)
  const real = types.getTypeParser(700)
  fetchMock
    .mockResolvedValueOnce(
      Response.json({
        person: {
          ...person,
          coverFaceId: bigint('17'),
          photoCount: int('2'),
          reviewCount: int('1'),
        },
        faces: [{ ...face, faceId: bigint('17'), score: real('0.75') }],
        more: true,
        nextCursor: 'next',
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        faces: [{ ...face, faceId: bigint('18'), score: null }],
        more: false,
        nextCursor: null,
      }),
    )
  const result = await loadPersonDetail(personId, 2, signal())
  expect(result).toMatchObject({
    status: 'ready',
    person: { coverFaceId: 17, photoCount: 2, reviewCount: 1 },
    faces: [
      { faceId: 17, score: 0.75 },
      { faceId: 18, score: null },
    ],
  })
})

it.each(['01', '0', '-1', '1.0', '1e3', ' 1', '1 ', '9007199254740992'])(
  'rejects noncanonical or unsafe BIGINT IDs: %s',
  async (badId) => {
    for (const badPage of [
      { ...page, person: { ...person, coverFaceId: badId } },
      { ...page, faces: [{ ...face, faceId: badId }] },
    ]) {
      fetchMock.mockResolvedValueOnce(Response.json(badPage))
      expect(await loadPersonDetail(personId, 200, signal())).toMatchObject({ status: 'error' })
    }
  },
)

it('accepts a canonical API response to an uppercase UUID route without accepting another person', async () => {
  const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  fetchMock.mockResolvedValueOnce(
    Response.json({ ...page, person: { ...person, personId: uuid }, status: 'missing' }),
  )
  expect(await loadPersonDetail(uuid.toUpperCase(), 200, signal())).toMatchObject({
    status: 'ready',
    person: { personId: uuid },
  })
  expect(fetchMock.mock.calls[0][0]).toBe(`/api/people/${uuid}`)
})

it('aborts stale person loads even when a transport ignores cancellation', async () => {
  let resolveOld!: (value: Response) => void
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      }),
  )
  const request = new AbortController()
  const oldLoad = loadPersonDetail(personId, 400, request.signal)
  const oldResult = expect(oldLoad).rejects.toMatchObject({ name: 'AbortError' })
  request.abort()
  fetchMock.mockResolvedValueOnce(
    Response.json({ ...page, person: { ...person, personId: otherId, name: 'Bob' } }),
  )
  expect(await loadPersonDetail(otherId, 200, signal())).toMatchObject({
    status: 'ready',
    person: { personId: otherId, name: 'Bob' },
  })
  resolveOld(Response.json({ ...page, more: true, nextCursor: 'old-next' }))
  await oldResult
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('validates subsequent pages and preserves the reviewed range on a successful retry', async () => {
  fetchMock
    .mockResolvedValueOnce(Response.json({ ...page, more: true, nextCursor: 'next' }))
    .mockResolvedValueOnce(Response.json({ faces: null, more: false, nextCursor: null }))
  expect(await loadPersonDetail(personId, 2, signal())).toMatchObject({ status: 'error' })
  fetchMock
    .mockResolvedValueOnce(Response.json({ ...page, more: true, nextCursor: 'next' }))
    .mockResolvedValueOnce(
      Response.json({ faces: [{ ...face, faceId: 2 }], more: false, nextCursor: null }),
    )
  expect(await loadPersonDetail(personId, 2, signal())).toMatchObject({
    status: 'ready',
    faces: [face, { ...face, faceId: 2 }],
  })
  expect(fetchMock.mock.calls[3][0]).toContain('summary=false&cursor=next')
})

it('rejects a stuck pagination cursor instead of looping through load-all', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ faces: [face], more: true, nextCursor: 'same' }))
  await expect(loadPersonFacePage(personId, 200, 'same', signal())).rejects.toMatchObject({
    status: 200,
  })
})

it('keeps HTTP status/code and requires explicit validation for array endpoints', async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: 'Not allowed', code: 'ACCESS_DENIED' }, { status: 403 }),
  )
  await expect(peopleApi('/api/people')).rejects.toMatchObject({
    status: 403,
    code: 'ACCESS_DENIED',
    message: 'Not allowed',
  })
  fetchMock.mockResolvedValueOnce(new Response('<html>unavailable</html>', { status: 502 }))
  await expect(peopleApi('/api/people')).rejects.toBeInstanceOf(ClientResponseError)
  fetchMock.mockResolvedValueOnce(Response.json([{ id: 1, action: 'rename' }]))
  await expect(peopleApi('/api/people')).rejects.toMatchObject({ status: 200 })
})
