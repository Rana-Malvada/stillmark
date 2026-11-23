import { beforeEach, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())
vi.mock('@/lib/postgres', () => ({ pgQuery: query }))
import { accountDisplayName, accountDisplayNames } from '@/lib/identity/account-display-name'
import { visibleAccountName } from '@/lib/identity/account-presentation'

beforeEach(() => query.mockReset())
it('resolves current and archived owners in one lookup without exposing IDs', async () => {
  const current = 'U_00000000000000000000000000000002'
  const archived = 'U_00000000000000000000000000000003'
  const missing = 'U_00000000000000000000000000000004'
  query.mockResolvedValue([
    { name: archived, display_name: 'Memberone' },
    { name: current, display_name: 'Keith' },
  ])
  const labels = await accountDisplayNames([current, archived, missing, current])
  expect(labels.get(current)).toBe('Keith')
  expect(labels.get(archived)).toBe('Memberone')
  expect(labels.get(missing)).toBe('Member')
  expect(query).toHaveBeenCalledTimes(1)
  expect(query.mock.calls[0][1]).toEqual([[current, archived, missing]])
})
it('hides opaque identities even when accidentally stored as display names', () => {
  for (const value of [
    'U_deadbeef',
    'u_DEADBEEF',
    'auth0|123456',
    '123e4567-e89b-12d3-a456-426614174000',
    '',
    null,
  ]) {
    expect(visibleAccountName(value)).toBe('Member')
  }
  expect(visibleAccountName(' Keith Lambert ')).toBe('Keith Lambert')
})
it('does not query an empty list', async () => {
  expect((await accountDisplayNames([])).size).toBe(0)
  expect(query).not.toHaveBeenCalled()
})

it('single-account lookup preserves the internal key while returning the profile name', async () => {
  const id = 'U_00000000000000000000000000000004'
  query.mockResolvedValue([{ name: id, display_name: 'membertwo' }])
  expect(await accountDisplayName(id)).toBe('membertwo')
  expect(query.mock.calls[0][1]).toEqual([[id]])
})
it('preserves readable legacy names when a profile is absent', async () => {
  query.mockResolvedValue([])
  expect(await accountDisplayName('GALLERYOWNER')).toBe('GALLERYOWNER')
})
