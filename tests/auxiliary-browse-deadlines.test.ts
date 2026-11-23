import { afterEach, expect, it, vi } from 'vitest'
import { databaseContext } from '@/lib/database/database-context'

const state = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('@/lib/identity/auth', () => ({ requireAuth: state.auth }))
vi.mock('@/lib/albums/album-access', () => ({ albumCaller: vi.fn() }))
vi.mock('@/lib/albums/folders', () => ({ listFolders: vi.fn() }))
vi.mock('@/lib/travel/travels', () => ({ travelStops: vi.fn(), viewportClusters: vi.fn() }))
vi.mock('@/lib/travel/travel-place-names', () => ({ addPlaceNames: vi.fn() }))
import { GET as folders } from '@/app/api/folders/route'
import { GET as travels } from '@/app/api/travels/route'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})
for (const [name, handler] of [
  ['folders', folders],
  ['travels', travels],
] as const) {
  it(`${name} cancels the database scope at the total request deadline`, async () => {
    vi.useFakeTimers()
    vi.stubEnv('BROWSE_REQUEST_TIMEOUT_MS', '100')
    let scope: ReturnType<typeof databaseContext.getStore>
    state.auth.mockImplementation(() => {
      scope = databaseContext.getStore()
      return new Promise(() => {})
    })
    const pending = handler(new Request(`https://app/api/${name}`))
    await vi.advanceTimersByTimeAsync(100)
    expect((await pending).status).toBe(504)
    expect(scope?.kind === 'request' && scope.signal?.aborted).toBe(true)
  })
  it(`${name} stops on browser cancellation without waiting for authentication`, async () => {
    let scope: ReturnType<typeof databaseContext.getStore>
    state.auth.mockImplementation(() => {
      scope = databaseContext.getStore()
      return new Promise(() => {})
    })
    const controller = new AbortController()
    const pending = handler(new Request(`https://app/api/${name}`, { signal: controller.signal }))
    controller.abort()
    expect((await pending).status).toBe(499)
    expect(scope?.kind === 'request' && scope.signal?.aborted).toBe(true)
  })
  it(`${name} is blocked on upload-only workers before authentication`, async () => {
    vi.stubEnv('UPLOAD_SERVICE_ONLY', 'true')
    expect((await handler(new Request(`https://app/api/${name}`))).status).toBe(404)
    expect(state.auth).not.toHaveBeenCalled()
  })
}
