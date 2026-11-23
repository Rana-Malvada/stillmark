import { afterEach, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ requireAuth: vi.fn() }))
const db = vi.hoisted(() => ({
  pgLookupMedia: vi.fn(),
  getDatabaseIdentity: vi.fn(),
  pgQueryOne: vi.fn(),
}))
vi.mock('@/lib/identity/auth', () => auth)
vi.mock('@/lib/postgres', () => db)
import { lookupMedia } from '@/lib/media/media-lookup'

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})
function setup() {
  vi.stubEnv('PG_MEDIA_LOOKUP_FUNCTION_ENABLED', 'true')
  auth.requireAuth.mockResolvedValue({ username: 'ALICE', role: 'admin' })
}
it('uses verified principal and zero elevated capabilities for ordinary authorized media', async () => {
  setup()
  db.pgLookupMedia.mockResolvedValue({ photo_id: 1 })
  expect(await lookupMedia('a')).toEqual({ photo_id: 1 })
  expect(db.getDatabaseIdentity).not.toHaveBeenCalled()
  expect(db.pgLookupMedia).toHaveBeenCalledWith('a', {
    username: 'ALICE',
    mainAdmin: false,
    adminRead: false,
    adminWrite: false,
    canWrite: false,
    accessManager: false,
  })
})
it('does not use ordinary access before authentication or retry a database failure as privilege escalation', async () => {
  setup()
  auth.requireAuth.mockRejectedValue(new Error('denied'))
  await expect(lookupMedia('a')).rejects.toThrow('denied')
  expect(db.pgLookupMedia).not.toHaveBeenCalled()
  auth.requireAuth.mockResolvedValue({ username: 'ALICE' })
  db.pgLookupMedia.mockRejectedValue(new Error('database failed'))
  await expect(lookupMedia('a')).rejects.toThrow('database failed')
  expect(db.getDatabaseIdentity).not.toHaveBeenCalled()
})
it('requires verified main-admin authority for a second lookup after ACL denial', async () => {
  setup()
  db.pgLookupMedia.mockResolvedValueOnce(null)
  db.getDatabaseIdentity.mockResolvedValue({ username: 'ALICE', mainAdmin: false })
  expect(await lookupMedia('private')).toBeNull()
  expect(db.pgLookupMedia).toHaveBeenCalledTimes(1)
  db.pgLookupMedia.mockResolvedValueOnce(null).mockResolvedValueOnce({ photo_id: 2 })
  db.getDatabaseIdentity.mockResolvedValue({ username: 'ALICE', mainAdmin: true })
  expect(await lookupMedia('private')).toEqual({ photo_id: 2 })
  expect(db.pgLookupMedia).toHaveBeenLastCalledWith('private', {
    username: 'ALICE',
    mainAdmin: true,
  })
})

it('reuses a combined lookup only for the authenticated principal and exact path', async () => {
  setup()
  const { databaseContext } = await import('@/lib/database/database-context')
  await databaseContext.run(
    { kind: 'request', gatewayMediaLookup: { username: 'ALICE', path: 'a', row: { photo_id: 1 } } },
    async () => {
      expect(await lookupMedia('a')).toEqual({ photo_id: 1 })
      expect(db.pgLookupMedia).not.toHaveBeenCalled()
      db.pgLookupMedia.mockResolvedValue({ photo_id: 2 })
      expect(await lookupMedia('b')).toEqual({ photo_id: 2 })
      expect(db.pgLookupMedia).toHaveBeenCalledTimes(1)
    },
  )
  db.pgLookupMedia.mockClear()
  await databaseContext.run(
    { kind: 'request', gatewayMediaLookup: { username: 'BOB', path: 'a', row: { photo_id: 3 } } },
    async () => {
      expect(await lookupMedia('a')).toEqual({ photo_id: 2 })
      expect(db.pgLookupMedia).toHaveBeenCalledTimes(1)
    },
  )
})
it('preserves a combined denial and cannot use prefetched data after failed authentication', async () => {
  setup()
  const { databaseContext } = await import('@/lib/database/database-context')
  await databaseContext.run(
    { kind: 'request', gatewayMediaLookup: { username: 'ALICE', path: 'a', row: null } },
    async () => {
      expect(await lookupMedia('a')).toBeNull()
      expect(db.pgLookupMedia).not.toHaveBeenCalled()
      auth.requireAuth.mockRejectedValue(new Error('revoked'))
      await expect(lookupMedia('a')).rejects.toThrow('revoked')
    },
  )
})
