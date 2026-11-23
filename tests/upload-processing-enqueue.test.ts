import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  one: vi.fn(),
  query: vi.fn(),
  freeze: vi.fn(),
  user: vi.fn(),
  access: vi.fn(),
  stage: vi.fn(),
  inTransaction: false,
}))
vi.mock('@/lib/postgres', () => ({
  pgQueryOne: m.one,
  pgQuery: m.query,
  pgAuthEpoch: async () => '1',
  pgTransaction: async (fn: () => unknown) => {
    m.inTransaction = true
    try {
      return await fn()
    } finally {
      m.inTransaction = false
    }
  },
}))
vi.mock('@/lib/albums/album-access', () => ({
  requireUploadUser: m.user,
  requireAlbumAccess: m.access,
}))
vi.mock('@/lib/upload/upload-sessions', () => ({
  freezeUploadMetadata: m.freeze,
  uploadId: (id: string) => id,
}))
vi.mock('@/lib/upload/upload-chunk-stage', () => ({ storeUploadChunk: m.stage }))
import { HttpError } from '@/lib/http'
import { enqueueUpload, uploadProcessingStatus } from '@/lib/upload/upload-processing-jobs'

const caller = { username: 'ALICE', role: 'viewer', mainAdmin: false, canManagePersonal: true }
beforeEach(() => {
  vi.resetAllMocks()
  m.user.mockResolvedValue(caller)
  m.query.mockResolvedValue([])
  m.freeze.mockResolvedValue({ total: 1 })
  m.stage.mockImplementation(async () => {
    expect(m.inTransaction).toBe(false)
    return 'upload-chunks/preview'
  })
})
afterEach(() => vi.unstubAllEnvs())
it('does not accept missing chunks or create a processing job', async () => {
  m.one
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ result: null, bytes: '10' })
    .mockResolvedValueOnce({ n: 0, bytes: '0', valid: false })
  await expect(enqueueUpload({ uploadId: 'id' })).rejects.toMatchObject({ status: 409 })
  expect(m.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false)
})
it('idempotently replays existing jobs without storing or scheduling another copy', async () => {
  m.one
    .mockResolvedValueOnce({ state: 'processing' })
    .mockResolvedValueOnce({ result: null, bytes: '10' })
  expect(await enqueueUpload({ uploadId: 'id' })).toEqual({ queued: true, uploadId: 'id' })
  expect(m.query).not.toHaveBeenCalled()
  expect(m.stage).not.toHaveBeenCalled()
})
it('stores previews in the stage, uses trusted caller identity, and preserves metadata', async () => {
  const thumbnail = Buffer.from('preview').toString('base64')
  m.freeze.mockResolvedValue({ total: 1, thumbnail })
  m.one
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ result: null, bytes: '10' })
    .mockResolvedValueOnce({ n: 1, bytes: '10', valid: true })
    .mockResolvedValueOnce({ n: 0 })
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ result: null, bytes: '10' })
    .mockResolvedValueOnce({ n: 1, bytes: '10', valid: true })
    .mockResolvedValueOnce({ n: 0 })
  await enqueueUpload({ uploadId: 'id', fileName: 'a.mov', thumbnail, caller: { username: 'BOB' } })
  const args = m.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO'))![1]
  expect(args[1]).toBe('ALICE')
  expect(JSON.parse(args[3])).toEqual(caller)
  expect(JSON.parse(args[2])).not.toHaveProperty('thumbnail')
  expect(JSON.parse(args[5])).toMatchObject({ path: 'upload-chunks/preview', size: 7 })
  expect(m.stage).toHaveBeenCalledOnce()
})
it('applies backlog backpressure before storing additional previews', async () => {
  vi.stubEnv('UPLOAD_QUEUED_PER_USER', '2')
  m.one
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ result: null, bytes: '10' })
    .mockResolvedValueOnce({ n: 1, bytes: '10', valid: true })
    .mockResolvedValueOnce({ n: 2 })
  await expect(enqueueUpload({ uploadId: 'id' })).rejects.toMatchObject({ status: 429 })
  expect(m.stage).not.toHaveBeenCalled()
  expect(m.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false)
})
it('rejects an account deleted while its preview is being stored without enqueueing work', async () => {
  vi.stubEnv('CUSTOMER_ACCOUNTS_ENABLED', 'true')
  let enabled = true
  m.freeze.mockResolvedValue({ total: 1, thumbnail: Buffer.from('preview').toString('base64') })
  m.one.mockImplementation(async (sql: string) => {
    if (sql.includes('upload_account_allowed')) return { allowed: enabled }
    if (sql.includes('SELECT state')) return null
    if (sql.includes('SELECT result,bytes')) return { result: null, bytes: '10' }
    if (sql.includes('bool_and')) return { n: 1, bytes: '10', valid: true }
    if (sql.includes('count(*)')) return { n: 0 }
    throw Error('Unexpected query')
  })
  m.stage.mockImplementation(async () => {
    expect(m.inTransaction).toBe(false)
    enabled = false
    return 'upload-chunks/preview'
  })
  await expect(enqueueUpload({ uploadId: 'id', fileName: 'a.mov' })).rejects.toMatchObject({
    status: 403,
  })
  expect(m.stage).toHaveBeenCalledOnce()
  expect(
    m.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO upload_processing_jobs')),
  ).toBe(false)
})

it('checks each completed album once per response and rechecks revoked access next request', async () => {
  const rows = () => [
    { uploadId: 'one', state: 'done', result: { eventId: 1 }, error: null },
    { uploadId: 'two', state: 'done', result: { eventId: 1 }, error: null },
    { uploadId: 'three', state: 'done', result: { eventId: 2 }, error: null },
  ]
  m.query.mockImplementation(async () => rows())
  await uploadProcessingStatus(['one', 'two', 'three'], 'ALICE')
  expect(m.access).toHaveBeenCalledTimes(2)
  m.access.mockRejectedValue(new HttpError(403, 'revoked'))
  const revoked = await uploadProcessingStatus(['one', 'two', 'three'], 'ALICE')
  expect(m.access).toHaveBeenCalledTimes(4)
  expect(revoked.every((r) => r.state === 'failed' && r.result === null)).toBe(true)
})
it('does not turn database failures into access denials', async () => {
  m.query.mockResolvedValue([{ uploadId: 'one', state: 'done', result: { eventId: 1 } }])
  m.access.mockRejectedValue(new Error('database unavailable'))
  await expect(uploadProcessingStatus(['one'], 'ALICE')).rejects.toThrow('database unavailable')
})
