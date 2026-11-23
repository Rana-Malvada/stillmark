import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as PGlite | null, access: vi.fn(), origin: vi.fn() }))
vi.mock('@/lib/albums/album-access', () => ({
  albumMutation: async (fn: (caller: object) => unknown) => fn({ username: 'ALICE' }),
  requireAlbumAccess: state.access,
}))
vi.mock('@/lib/postgres', () => ({
  pgQueryOne: async (sql: string, params: unknown[]) =>
    (await state.db!.query(sql, params)).rows[0],
}))
vi.mock('@/lib/database/database-context', () => ({ withDatabaseRequest: (fn: unknown) => fn }))
vi.mock('@/lib/identity/auth', () => ({ requireSameOrigin: state.origin }))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: vi.fn() }))
import { applyAlbumDate } from '@/lib/albums/album-date'
import { PATCH } from '@/app/api/events/[eventId]/date/route'
import { HttpError } from '@/lib/http'

beforeAll(async () => {
  state.db = new PGlite()
  await state.db.exec(
    `CREATE TABLE photos(photo_id int,event_id int,date_taken timestamptz,updated_at timestamptz,ingest_status text,media_type text); SET timezone='America/New_York';`,
  )
})
afterAll(async () => state.db?.close())
beforeEach(async () => {
  vi.resetAllMocks()
  await state.db!.exec(`TRUNCATE photos; INSERT INTO photos VALUES
    (1,10,'2024-02-01T23:45:12.123Z',NULL,'READY','photo'),
    (2,10,NULL,NULL,'READY','photo'),
    (3,11,'2024-02-01T01:02:03Z',NULL,'READY','photo'),
    (4,10,NULL,NULL,'READY','video'),(5,10,NULL,NULL,'PENDING','photo');`)
})
it('updates every ready photo in only the chosen album, preserving UTC times across timezone changes', async () => {
  expect(await applyAlbumDate(10, '2026-06-15', 'all')).toEqual({ count: 2 })
  const { rows } = await state.db!.query<{ photo_id: number; date_taken: Date | null }>(
    'SELECT photo_id,date_taken FROM photos ORDER BY photo_id',
  )
  expect(rows.map((r) => r.date_taken?.toISOString() ?? null)).toEqual([
    '2026-06-15T23:45:12.123Z',
    '2026-06-15T00:00:00.000Z',
    '2024-02-01T01:02:03.000Z',
    null,
    null,
  ])
  expect(state.access).toHaveBeenCalledWith(10, true, { username: 'ALICE' })
})
it('can fill missing dates without overwriting existing ones', async () => {
  expect(await applyAlbumDate(10, '2024-02-29', 'missing')).toEqual({ count: 1 })
  const { rows } = await state.db!.query<{ date_taken: Date }>(
    'SELECT date_taken FROM photos WHERE photo_id=1',
  )
  expect(rows[0].date_taken.toISOString()).toBe('2024-02-01T23:45:12.123Z')
})
it('rejects invalid calendar dates and scopes before writing', async () => {
  for (const date of [
    '2025-02-29',
    '2026-04-31',
    '0000-01-01',
    '2026-13-01',
    null,
    '',
    '2026-01-01T12:00:00Z',
  ])
    await expect(applyAlbumDate(10, date, 'all')).rejects.toMatchObject({ status: 400 })
  await expect(applyAlbumDate(10, '2026-01-01', 'anything')).rejects.toMatchObject({ status: 400 })
})
it('rejects unauthorized and cross-origin writes without changing photos', async () => {
  const req = () =>
    new Request('https://app/api/events/10/date', {
      method: 'PATCH',
      body: JSON.stringify({ date: '2026-01-01', scope: 'all' }),
    })
  const context = { params: Promise.resolve({ eventId: '10' }) }
  state.access.mockRejectedValueOnce(new HttpError(403, 'Album owner permission required'))
  expect((await PATCH(req(), context)).status).toBe(403)
  state.origin.mockRejectedValueOnce(new HttpError(403, 'Invalid origin'))
  expect((await PATCH(req(), context)).status).toBe(403)
  const { rows } = await state.db!.query('SELECT photo_id FROM photos WHERE updated_at IS NOT NULL')
  expect(rows).toEqual([])
})
