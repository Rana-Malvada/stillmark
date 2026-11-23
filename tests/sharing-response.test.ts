import { describe, expect, it } from 'vitest'
import {
  isAlbumSharing,
  isPublicLinkCreated,
  isPublicLinks,
  isSharedLinks,
  isSharingChanged,
} from '../lib/albums/sharing-response'
import { readClientResponse } from '../lib/client-response'

const sharing = {
  owner: 'ALICE',
  ownerDisplayName: 'Alice',
  visibility: 'PRIVATE',
  canEdit: true,
  mainAdmin: false,
  shares: [{ username: 'BOB', displayName: 'Bob' }],
}
const link = {
  id: 'link-1',
  event_id: 101,
  event_name: 'Album',
  owner_username: 'ALICE',
  created_by: 'ALICE',
  created_at: '2026-11-21T00:00:00Z',
  expires_at: '2026-12-21T00:00:00Z',
  allow_downloads: false,
  include_location: false,
  include_people: false,
  selected_count: null,
  status: 'active',
  canRevoke: true,
}
const result = {
  links: [link],
  hasMore: false,
  owners: ['ALICE'],
  ownerLabels: { ALICE: 'Alice' },
  canFilterOwners: true,
}
describe('sharing response contracts', () => {
  it('accepts real optional display names, empty shares and selected links', () => {
    expect(isAlbumSharing(sharing)).toBe(true)
    // The legacy nullable database value uses the existing private display fallback.
    expect(isAlbumSharing({ ...sharing, visibility: null })).toBe(true)
    expect(isAlbumSharing({ ...sharing, ownerDisplayName: undefined, shares: [] })).toBe(true)
    expect(isSharedLinks(result)).toBe(true)
    expect(
      isSharedLinks({ ...result, links: [{ ...link, selected_count: 2, status: 'invalidated' }] }),
    ).toBe(true)
  })
  it('rejects malformed nested lists and permission fields before rendering', () => {
    for (const invalid of [
      {},
      { ...sharing, shares: null },
      { ...sharing, shares: [{}] },
      { ...sharing, canEdit: 'true' },
      { ...sharing, visibility: 'unknown' },
    ])
      expect(isAlbumSharing(invalid)).toBe(false)
    for (const invalid of [
      {},
      { ...result, links: [{}] },
      { ...result, links: [null] },
      { ...result, owners: 'ALICE' },
      { ...result, ownerLabels: { ALICE: {} } },
      { ...result, links: [{ ...link, status: '' }] },
      { ...result, links: [{ ...link, canRevoke: 'true' }] },
      { ...result, links: [{ ...link, created_at: 'bad' }] },
    ])
      expect(isSharedLinks(invalid)).toBe(false)
  })
  it('validates album link rows and only accepts the generated local share path', () => {
    const row = { ...link, revoked_at: null }
    expect(isPublicLinks([row])).toBe(true)
    expect(isPublicLinks([{ ...row, revoked_at: '2026-11-22T00:00:00Z' }])).toBe(true)
    for (const value of [
      {},
      [null],
      [{ ...row, selected_count: '2' }],
      [{ ...row, revoked_at: false }],
    ])
      expect(isPublicLinks(value)).toBe(false)
    const created = { id: link.id, path: '/share/' + 'a'.repeat(43), expiresAt: link.expires_at }
    expect(isPublicLinkCreated(created)).toBe(true)
    for (const path of [
      '//evil.test',
      '/share/abc',
      '/share/' + 'a'.repeat(43) + '?next=evil',
      'https://evil.test',
    ])
      expect(isPublicLinkCreated({ ...created, path })).toBe(false)
  })
  it('requires the actual mutation acknowledgment', async () => {
    expect(isSharingChanged({ ok: true })).toBe(true)
    for (const value of [{}, { ok: false }, { ok: 'true' }, []])
      await expect(
        readClientResponse(Response.json(value), 'Update failed', isSharingChanged),
      ).rejects.toMatchObject({ status: 200 })
  })
  it('retains denied HTTP status even for a non-JSON response', async () => {
    await expect(
      readClientResponse(
        new Response('<html>Denied</html>', { status: 403 }),
        'Unavailable',
        isSharedLinks,
      ),
    ).rejects.toMatchObject({ status: 403, message: 'Unavailable' })
  })
})
