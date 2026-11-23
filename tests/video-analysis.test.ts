import { beforeEach, expect, it, vi } from 'vitest'
import {
  analysisFields,
  parseVideoResult,
  videoEligibility,
  videoSearchText,
} from '@/lib/video/video-analysis-format'

const s = vi.hoisted(() => ({
  one: vi.fn(),
  query: vi.fn(),
  admin: vi.fn(),
  access: vi.fn(),
  sf: vi.fn(),
  copy: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/lib/postgres', () => ({
  pgQuery: s.query,
  pgQueryOne: s.one,
  pgTransaction: async (f: any) => f(),
  withAdvisoryLock: async (_n: string, f: any) => f(),
}))
vi.mock('@/lib/identity/auth', () => ({ requireAdmin: s.admin }))
vi.mock('@/lib/albums/album-access', () => ({
  requirePhotoAccess: s.access,
  accessibleAlbumIds: async () => [1],
  albumMutation: async (f: any) => f({ role: 'admin', username: 'ADMIN' }),
}))
vi.mock('@/lib/snowflake', () => ({
  querySnowflakeLongRunning: s.sf,
  querySnowflakeStorage: vi.fn(),
}))
vi.mock('@/lib/costs/cost-work', () => ({ costWork: async (_c: any, _o: any, f: any) => f() }))
vi.mock('@/lib/video/video-compression', () => ({
  prepareAnalysisCopy: s.copy,
  removeAnalysisCopy: s.remove,
  cleanupLocalAnalysisCopies: async () => {},
  VideoPreparationError: class extends Error {},
}))
import {
  getVideoAnalysis,
  processVideoAnalyses,
  requestVideoAnalysis,
} from '@/lib/video/video-analysis'

const result = {
  ...Object.fromEntries(
    analysisFields.map((k) => [k, k === 'transcript' ? '[00:01] Speaker 1: hola' : 'Example']),
  ),
  tags: ['guitar'],
} as any
const video = {
  photo_id: 1,
  media_type: 'video',
  ingest_status: 'READY',
  original_stage_path: 'originals/1/original.mov',
  file_size_bytes: '150000000',
  owner_username: 'ALICE',
}
beforeEach(() => {
  vi.resetAllMocks()
  s.admin.mockResolvedValue({ username: 'ADMIN', role: 'admin' })
  s.access.mockResolvedValue({ caller: { role: 'viewer' } })
  s.query.mockResolvedValue([])
})
it('validates complete results and indexes transcript, translation and actions', () => {
  expect(parseVideoResult(JSON.stringify(result))).toEqual(result)
  expect(() => parseVideoResult({ summary: 'only' })).toThrow()
  expect(() => parseVideoResult({ ...result, tags: [5] })).toThrow()
  expect(videoSearchText(result)).toContain('hola')
  expect(videoEligibility(video)).toBeNull()
  expect(videoEligibility({ ...video, media_type: 'photo' })).toBeTruthy()
})
it('denies non-admin runs before touching video or queue', async () => {
  s.admin.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
  await expect(requestVideoAnalysis(1)).rejects.toMatchObject({ status: 403 })
  expect(s.one).not.toHaveBeenCalled()
  expect(s.query).not.toHaveBeenCalled()
})
it('enforces video access even for an admin', async () => {
  s.access.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))
  await expect(requestVideoAnalysis(1)).rejects.toMatchObject({ status: 404 })
  expect(s.one).not.toHaveBeenCalled()
})
it('returns active job without charging/queuing another', async () => {
  s.one.mockResolvedValueOnce(video).mockResolvedValueOnce({ id: 'existing', status: 'running' })
  expect(await requestVideoAnalysis(1, true)).toEqual({ id: 'existing', status: 'running' })
  expect(s.query).not.toHaveBeenCalled()
  expect(s.sf).not.toHaveBeenCalled()
})
it('requires explicit rerun after success', async () => {
  s.one
    .mockResolvedValueOnce(video)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: 'done' })
  await expect(requestVideoAnalysis(1)).rejects.toMatchObject({ status: 409 })
})
it('allows authorized viewers to read saved analysis without generating anything', async () => {
  s.one.mockResolvedValueOnce(video).mockResolvedValueOnce({ result, status: 'completed' })
  s.query.mockResolvedValueOnce([{ result, status: 'completed' }])
  expect(await getVideoAnalysis(1)).toMatchObject({ canRun: false, completed: { result } })
  expect(s.admin).not.toHaveBeenCalled()
  expect(s.sf).not.toHaveBeenCalled()
})
it('analyzes temporary copy but stores results against the original ID and cleans up', async () => {
  s.one
    .mockResolvedValue({ id: 'job' })
    .mockResolvedValueOnce({ id: 'job', photo_id: 1, owner_username: 'ALICE' })
    .mockResolvedValueOnce(video)
  s.copy.mockResolvedValue({ path: 'analysis-temp/job/analysis.mp4', bytes: 2000000 })
  s.sf.mockResolvedValue([{ RESULT: JSON.stringify(result) }])
  await processVideoAnalyses()
  expect(s.sf.mock.calls[0][1].binds[2]).toBe('analysis-temp/job/analysis.mp4')
  expect(
    s.query.mock.calls.some(
      ([sql, params]) => sql.includes('UPDATE photos SET updated_at') && params[0] === 1,
    ),
  ).toBe(true)
  expect(s.remove).toHaveBeenCalledWith('analysis-temp/job/analysis.mp4')
  expect(s.query.mock.calls.some(([sql]) => sql.includes('SET original_stage_path'))).toBe(false)
})
it('cleans up after model failure and does not retry automatically', async () => {
  s.one
    .mockResolvedValue({ id: 'job' })
    .mockResolvedValueOnce({ id: 'job', photo_id: 1, owner_username: 'ALICE' })
    .mockResolvedValueOnce(video)
  s.copy.mockResolvedValue({ path: 'analysis-temp/job/analysis.mp4', bytes: 2000000 })
  s.sf.mockRejectedValue(new Error('Unavailable'))
  await processVideoAnalyses()
  expect(s.sf).toHaveBeenCalledTimes(1)
  expect(s.remove).toHaveBeenCalledTimes(1)
  expect(s.query.mock.calls.some(([sql]) => sql.includes("status='failed',error=$2"))).toBe(true)
})
it('never submits oversized or incomplete preparation results after a conversion error', async () => {
  s.one
    .mockResolvedValue({ id: 'job' })
    .mockResolvedValueOnce({ id: 'job', photo_id: 1, owner_username: 'ALICE' })
    .mockResolvedValueOnce(video)
  s.copy.mockRejectedValue(new Error('too long'))
  await processVideoAnalyses()
  expect(s.sf).not.toHaveBeenCalled()
})

it('does not start paid inference after losing its claim during preparation', async () => {
  s.one
    .mockResolvedValue(null)
    .mockResolvedValueOnce({ id: 'job', photo_id: 1, owner_username: 'ALICE' })
    .mockResolvedValueOnce(video)
  s.copy.mockResolvedValue({ path: 'analysis-temp/job/analysis.mp4', bytes: 2000000 })
  await processVideoAnalyses()
  expect(s.sf).not.toHaveBeenCalled()
  expect(s.remove).toHaveBeenCalled()
})
it('rejects a late AI result after its claim was replaced', async () => {
  s.one.mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE video_analyses SET status='))
      return { id: 'job', photo_id: 1, owner_username: 'ALICE' }
    if (sql.startsWith('SELECT * FROM photos')) return video
    if (sql.startsWith('UPDATE video_analyses SET lease_until')) return { id: 'job' }
    return null
  })
  s.copy.mockResolvedValue({ path: 'analysis-temp/job/analysis.mp4', bytes: 2000000 })
  s.sf.mockResolvedValue([{ RESULT: JSON.stringify(result) }])
  await processVideoAnalyses()
  expect(s.sf).toHaveBeenCalledTimes(1)
  expect(s.query.mock.calls.some(([sql]) => sql.includes("SET status='completed'"))).toBe(false)
})
