import { beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  origin: vi.fn(),
  upload: vi.fn(),
  auth: vi.fn(),
  track: vi.fn(),
  photo: vi.fn(),
  rename: vi.fn(),
  tag: vi.fn(),
}))
vi.mock('@/lib/identity/auth', () => ({ requireSameOrigin: s.origin, requireAuth: s.auth }))
vi.mock('@/lib/albums/album-access', () => ({
  requireUploadUser: s.upload,
  requirePhotoAccess: s.photo,
}))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: s.track }))
vi.mock('@/lib/people', async (actual) => ({
  ...(await actual<typeof import('@/lib/people')>()),
  renamePerson: s.rename,
  tagPhoto: s.tag,
  photoPeople: async () => ({ canEdit: false, faces: [] }),
}))
import { PATCH } from '@/app/api/people/[personId]/route'
import { GET as photoPeople, POST as tag } from '@/app/api/photos/[photoId]/people/route'
import { POST as faces } from '@/app/api/people/[personId]/faces/route'
import { HttpError } from '@/lib/http'

const DANA = '22222222-2222-4222-8222-222222222222'
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) })
const json = (body: unknown) =>
  new Request('https://app/api/x', { method: 'POST', body: JSON.stringify(body) })
beforeEach(() => {
  vi.resetAllMocks()
  s.rename.mockResolvedValue({ personId: DANA, name: 'Dana' })
})

it('renames through the owner write path, uncached, without logging the name', async () => {
  const response = await PATCH(json({ name: 'Dana' }), params({ personId: DANA }))
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(s.origin).toHaveBeenCalled()
  expect(s.upload).toHaveBeenCalled()
  expect(s.rename).toHaveBeenCalledWith(DANA, 'Dana')
  expect(s.track).toHaveBeenCalledWith('people_changed', '', { mode: 'rename' })
  expect(JSON.stringify(s.track.mock.calls)).not.toContain('Dana')
})
it('blocks cross-site and read-only callers before touching data', async () => {
  s.origin.mockRejectedValueOnce(new HttpError(403, 'Same-origin request required'))
  expect((await PATCH(json({ name: 'X' }), params({ personId: DANA }))).status).toBe(403)
  s.upload.mockRejectedValueOnce(new HttpError(403, 'Read-only administrators cannot upload'))
  expect((await tag(json({ name: 'X' }), params({ photoId: '1' }))).status).toBe(403)
  expect(s.rename).not.toHaveBeenCalled()
  expect(s.tag).not.toHaveBeenCalled()
  expect(s.track).not.toHaveBeenCalled()
})
it('validates request shape', async () => {
  expect((await PATCH(json({ name: 'A', hidden: true }), params({ personId: DANA }))).status).toBe(
    400,
  )
  expect(
    (await faces(json({ action: 'drop', faceIds: [1] }), params({ personId: DANA }))).status,
  ).toBe(400)
  expect(
    (
      await PATCH(
        new Request('https://app', { method: 'PATCH', body: '[]' }),
        params({ personId: DANA }),
      )
    ).status,
  ).toBe(400)
})
it('hides internal errors and does not record failed changes', async () => {
  s.rename.mockRejectedValueOnce(new Error('relation face_people secret detail'))
  const response = await PATCH(json({ name: 'Dana' }), params({ personId: DANA }))
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain('secret')
  expect(s.track).not.toHaveBeenCalled()
})
it('returns 404 for photos the caller cannot read', async () => {
  s.photo.mockRejectedValueOnce(new HttpError(404, 'Photo not found'))
  const response = await photoPeople(new Request('https://app'), params({ photoId: '5' }))
  expect(response.status).toBe(404)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect((await photoPeople(new Request('https://app'), params({ photoId: 'x' }))).status).toBe(400)
})

it('bounds People reads, cancels their database scope, and keeps timeout responses private', async () => {
  const { peopleRead } = await import('@/lib/people/people-api')
  const { databaseContext } = await import('@/lib/database/database-context')
  vi.useFakeTimers()
  vi.stubEnv('BROWSE_REQUEST_TIMEOUT_MS', '100')
  let scope: ReturnType<typeof databaseContext.getStore>
  const handler = peopleRead(async () => {
    scope = databaseContext.getStore()
    await new Promise(() => {})
  })
  try {
    const pending = handler(new Request('https://app/api/people'), params({}))
    await vi.advanceTimersByTimeAsync(100)
    const response = await pending
    expect(response.status).toBe(504)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(scope?.kind).toBe('request')
    expect(scope?.kind === 'request' && scope.signal?.aborted).toBe(true)
  } finally {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  }
})

it('rejects People reads on upload-only services before authentication or data access', async () => {
  const { peopleRead } = await import('@/lib/people/people-api')
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'true')
  const read = vi.fn()
  try {
    const response = await peopleRead(read)(new Request('https://app/api/people'), params({}))
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(read).not.toHaveBeenCalled()
    expect(s.auth).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllEnvs()
  }
})
