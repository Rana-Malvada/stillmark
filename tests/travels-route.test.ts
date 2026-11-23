import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ auth: vi.fn(), stops: vi.fn() }))
vi.mock('@/lib/identity/auth', () => ({ requireAuth: m.auth }))
vi.mock('@/lib/travel/travels', () => ({ travelStops: m.stops }))
vi.mock('@/lib/travel/travel-place-names', () => ({
  addPlaceNames: async (stops: unknown) => stops,
}))
import { GET } from '@/app/api/travels/route'
import { HttpError } from '@/lib/http'

beforeEach(() => {
  vi.resetAllMocks()
  m.auth.mockResolvedValue({ username: 'ALICE' })
  m.stops.mockResolvedValue([])
})
it('requires authentication before querying location data', async () => {
  m.auth.mockRejectedValue(new HttpError(401, 'Authentication required'))
  expect((await GET(new Request('https://app/api/travels'))).status).toBe(401)
  expect(m.stops).not.toHaveBeenCalled()
})
it('defaults to owned albums and forbids shared caching of locations', async () => {
  const r = await GET(new Request('https://app/api/travels'))
  expect(m.stops).toHaveBeenCalledWith('mine')
  expect(r.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await r.json()).toEqual({ stops: [] })
})
it('accepts only defined scopes', async () => {
  expect((await GET(new Request('https://app/api/travels?scope=all'))).status).toBe(400)
  expect(m.stops).not.toHaveBeenCalled()
  await GET(new Request('https://app/api/travels?scope=accessible'))
  expect(m.stops).toHaveBeenCalledWith('accessible')
})
