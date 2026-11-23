import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  event: vi.fn(),
  prepare: vi.fn(),
  write: vi.fn(),
  query: vi.fn(),
  create: vi.fn(),
  access: vi.fn(),
  one: vi.fn(),
  inTransaction: false,
}))
vi.mock('@/lib/albums/folders', () => ({ requireFolderWrite: m.write }))
vi.mock('@/lib/albums/album-access', () => ({
  requireUploadUser: vi.fn(),
  requireAlbumAccess: m.access,
}))
vi.mock('@/lib/postgres', () => ({
  pgQuery: m.query,
  pgQueryOne: m.one,
  pgTransaction: async (fn: () => unknown) => {
    m.inTransaction = true
    try {
      return await fn()
    } finally {
      m.inTransaction = false
    }
  },
}))
vi.mock('@/lib/albums/events', () => ({
  getUploadEvent: m.event,
  createEvent: m.create,
  findEventBySourceFolder: vi.fn(),
  updateEventPhotoCount: vi.fn(),
  setCoverPhoto: vi.fn(),
}))
vi.mock('@/lib/upload/upload-processing', () => ({
  prepareImage: m.prepare,
  prepareVideo: m.prepare,
  SUPPORTED_EXTS: new Set(['jpg', 'mov']),
  VIDEO_EXTS: new Set(['mov']),
}))
import { ingestUpload } from '@/lib/upload/ingest-upload'

const caller = { username: 'owner', mainAdmin: false, role: 'user' } as any
beforeEach(() => {
  vi.clearAllMocks()
  m.one.mockReset()
  m.event.mockResolvedValue({ folderId: null })
})
afterEach(() => vi.unstubAllEnvs())
it('fences album creation before processing when account deletion wins', async () => {
  vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', 'true')
  m.one.mockImplementation(async (sql: string) => {
    expect(m.inTransaction).toBe(true)
    expect(sql).toContain('upload_account_allowed')
    return { allowed: false }
  })
  await expect(
    ingestUpload(
      Buffer.from('image'),
      {
        fileName: 'file.jpg',
        folderName: 'new',
        folderId: 7,
        eventName: 'new',
      },
      undefined,
      caller,
    ),
  ).rejects.toMatchObject({ status: 403 })
  expect(m.create).not.toHaveBeenCalled()
  expect(m.query).not.toHaveBeenCalled()
  expect(m.prepare).not.toHaveBeenCalled()
})
it.each(['jpg', 'mov'])(
  'rejects a new %s upload without a selected folder before processing',
  async (ext) => {
    await expect(
      ingestUpload(
        Buffer.from('test'),
        { fileName: 'file.' + ext, folderName: 'album' },
        undefined,
        caller,
      ),
    ).rejects.toThrow('Choose a folder')
    expect(m.prepare).not.toHaveBeenCalled()
  },
)
it('rejects uploads into an existing unfiled album', async () => {
  await expect(
    ingestUpload(
      Buffer.from('test'),
      { fileName: 'file.mov', folderName: 'album', eventId: 1 },
      undefined,
      caller,
    ),
  ).rejects.toThrow('Assign this album')
  expect(m.prepare).not.toHaveBeenCalled()
})
it('accepts an existing filed album without requiring a redundant folder parameter', async () => {
  m.event.mockResolvedValue({ folderId: 7 })
  m.prepare.mockRejectedValue(new Error('processing reached'))
  await expect(
    ingestUpload(
      Buffer.from('test'),
      { fileName: 'file.mov', folderName: 'album', eventId: 1 },
      undefined,
      caller,
    ),
  ).rejects.toThrow('processing reached')
  expect(m.prepare).toHaveBeenCalled()
})

it.each(['viewer', 'admin'] as const)(
  'uses folder metadata only for an admin (%s)',
  async (role) => {
    m.event.mockResolvedValue({ folderId: 7 })
    m.create.mockResolvedValue(42)
    m.prepare.mockRejectedValue(new Error('processing reached'))
    await expect(
      ingestUpload(
        Buffer.from('test'),
        {
          fileName: 'file.jpg',
          folderName: '9173 Bruto Denver CO September 2026',
          folderId: 7,
          eventName: 'My dinner',
          sortOrder: null,
          eventMonth: null,
          eventYear: null,
        },
        undefined,
        { ...caller, role },
      ),
    ).rejects.toThrow('processing reached')
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'My dinner',
        sortOrder: role === 'admin' ? 9173 : 0,
        eventMonth: role === 'admin' ? 9 : null,
        eventYear: role === 'admin' ? 2026 : null,
      }),
    )
  },
)

it('preserves a non-admin explicit sort order and date', async () => {
  m.event.mockResolvedValue({ folderId: 7 })
  m.create.mockResolvedValue(42)
  m.prepare.mockRejectedValue(new Error('processing reached'))
  await expect(
    ingestUpload(
      Buffer.from('test'),
      {
        fileName: 'file.jpg',
        folderName: '9173 Bruto Denver CO September 2026',
        folderId: 7,
        eventName: 'My dinner',
        sortOrder: 12,
        eventMonth: 4,
        eventYear: 2025,
      },
      undefined,
      caller,
    ),
  ).rejects.toThrow('processing reached')
  expect(m.create).toHaveBeenCalledWith(
    expect.objectContaining({
      eventName: 'My dinner',
      sortOrder: 12,
      eventMonth: 4,
      eventYear: 2025,
    }),
  )
})

it('rechecks authorization under the shared barrier before publication', async () => {
  m.event.mockResolvedValue({ folderId: 7 })
  m.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'))
  const publishMedia = vi.fn()
  m.prepare.mockResolvedValue(publishMedia)
  await expect(
    ingestUpload(
      Buffer.from('test'),
      {
        fileName: 'file.jpg',
        folderName: 'album',
        eventId: 1,
      },
      undefined,
      caller,
    ),
  ).rejects.toThrow('revoked')
  expect(publishMedia).not.toHaveBeenCalled()
  const locks = m.query.mock.calls.filter(([sql]) => sql.includes('pg_advisory'))
  expect(locks).toEqual([
    ["SELECT pg_advisory_xact_lock_shared(hashtextextended('photo-management',0))"],
    ['SELECT pg_advisory_xact_lock($1)', [1]],
    ["SELECT pg_advisory_xact_lock_shared(hashtextextended('photo-management',0))"],
    ['SELECT pg_advisory_xact_lock($1)', [1]],
  ])
})
it('keeps album discovery and creation exclusive without upgrading a shared lock', async () => {
  m.event.mockResolvedValue({ folderId: 7 })
  m.access.mockResolvedValue(undefined)
  m.create.mockResolvedValue(42)
  m.prepare.mockRejectedValue(new Error('prepared'))
  await expect(
    ingestUpload(
      Buffer.from('test'),
      {
        fileName: 'file.jpg',
        folderName: 'new',
        folderId: 7,
        eventName: 'new',
      },
      undefined,
      caller,
    ),
  ).rejects.toThrow('prepared')
  expect(m.query.mock.calls.filter(([sql]) => sql.includes('pg_advisory'))).toEqual([
    ["SELECT pg_advisory_xact_lock(hashtextextended('photo-management',0))"],
    ['SELECT pg_advisory_xact_lock($1)', [42]],
  ])
})
