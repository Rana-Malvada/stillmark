import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { objects } from '@/config/deployment.mjs'
import { withServiceDatabase } from '@/lib/database/database-context'

const state = vi.hoisted(() => ({
  db: null as PGlite | null,
  remote: { photo: [] as number[], event: [] as number[] },
  query: vi.fn(),
  snowflake: vi.fn(),
}))
vi.mock('@/lib/postgres', () => ({
  pgQuery: state.query,
  pgQueryOne: async (sql: string, params: unknown[]) => (await state.query(sql, params))[0],
  withAdvisoryLock: async (_key: string, run: () => unknown) => run(),
}))
vi.mock('@/lib/snowflake', () => ({
  querySnowflake: state.snowflake,
  querySnowflakeLongRunning: vi.fn(),
}))
import { enqueueFullSearchRepair } from '@/lib/search/search-repair'
import { syncSearch } from '@/lib/search/search-sync'

beforeAll(async () => {
  state.db = new PGlite()
  await state.db.exec(`CREATE SEQUENCE search_revision;
    CREATE TABLE photos(photo_id int PRIMARY KEY);
    CREATE TABLE events(event_id int PRIMARY KEY);
    CREATE TABLE search_queue(kind text,id bigint,publication_attempted boolean DEFAULT false,
      revision bigint DEFAULT nextval('search_revision'),PRIMARY KEY(kind,id));
    CREATE TABLE maintenance_state(name text PRIMARY KEY,last_error text);`)
})
afterAll(async () => state.db?.close())
beforeEach(async () => {
  await state.db!.exec('TRUNCATE photos,events,search_queue,maintenance_state')
  state.remote = { photo: [], event: [] }
  state.query
    .mockReset()
    .mockImplementation(
      async (sql: string, params?: unknown[]) => (await state.db!.query(sql, params)).rows,
    )
  state.snowflake
    .mockReset()
    .mockImplementation(async (sql: string, options: { binds: number[] }) => {
      expect(sql).toMatch(/WHERE (PHOTO_ID|EVENT_ID)>\? ORDER BY \1 LIMIT 1000$/)
      const kind = sql.includes(objects.photoSearchTable) ? 'photo' : 'event'
      return state.remote[kind]
        .filter((id) => id > options.binds[0])
        .slice(0, 1000)
        .map((ID) => ({ ID }))
    })
})

it('repairs a large catalog in bounded pages while preserving remote-only deletion evidence and revisions', async () => {
  state.remote.photo = Array.from({ length: 10005 }, (_, i) => i + 1)
  state.remote.event = [1, 2, 3]
  await state.db!.exec(`INSERT INTO photos SELECT generate_series(1001,11005);
    INSERT INTO events VALUES(2),(4);
    INSERT INTO search_queue(kind,id) VALUES('photo',1);`)
  const previous = (
    await state.db!.query<{ revision: number }>('SELECT revision FROM search_queue')
  ).rows[0].revision
  await withServiceDatabase(enqueueFullSearchRepair)
  const counts = (
    await state.db!.query(`SELECT count(*)::int total,
    count(*) FILTER(WHERE publication_attempted)::int attempted FROM search_queue`)
  ).rows[0]
  expect(counts).toEqual({ total: 11009, attempted: 10008 })
  expect(state.snowflake).toHaveBeenCalledTimes(12)
  const writes = state.query.mock.calls.filter(([sql]) =>
    sql.startsWith('INSERT INTO search_queue'),
  )
  expect(writes).toHaveLength(24)
  expect(writes.every(([, params]) => params[1].length <= 1000)).toBe(true)
  expect(
    (
      await state.db!.query(
        'DELETE FROM search_queue WHERE kind=$1 AND id=$2 AND revision=$3 RETURNING id',
        ['photo', 1, previous],
      )
    ).rows,
  ).toEqual([])
})

it('deduplicates remote IDs before a set-based upsert', async () => {
  state.remote.photo = [1, 1, 2]
  await enqueueFullSearchRepair()
  expect((await state.db!.query('SELECT id FROM search_queue ORDER BY id')).rows).toEqual([
    { id: 1 },
    { id: 2 },
  ])
})

it('retains a committed page on cancellation and safely completes when restarted', async () => {
  state.remote.photo = Array.from({ length: 1500 }, (_, i) => i + 1)
  const controller = new AbortController()
  const original = state.query.getMockImplementation()!
  state.query.mockImplementation(async (sql, params) => {
    const result = await original(sql, params)
    if (sql.startsWith('INSERT INTO search_queue')) controller.abort(new Error('Repair stopped'))
    return result
  })
  await expect(withServiceDatabase(enqueueFullSearchRepair, controller.signal)).rejects.toThrow(
    'Repair stopped',
  )
  expect((await state.db!.query('SELECT count(*)::int n FROM search_queue')).rows[0]).toEqual({
    n: 1000,
  })
  expect(state.snowflake).toHaveBeenCalledTimes(1)
  state.query.mockImplementation(original)
  await enqueueFullSearchRepair()
  expect(
    (await state.db!.query('SELECT count(*)::int n FROM search_queue WHERE publication_attempted'))
      .rows[0],
  ).toEqual({ n: 1500 })
})

it('records a remote discovery failure before publication and retains already queued work', async () => {
  state.remote.photo = Array.from({ length: 1001 }, (_, i) => i + 1)
  const original = state.snowflake.getMockImplementation()!
  state.snowflake.mockImplementation(async (sql, options) => {
    if (options.binds[0] === 1000) throw new Error('Remote page unavailable')
    return original(sql, options)
  })
  await expect(syncSearch({ force: true, full: true })).rejects.toThrow('Remote page unavailable')
  expect((await state.db!.query('SELECT last_error FROM maintenance_state')).rows[0]).toEqual({
    last_error: 'Remote page unavailable',
  })
  expect((await state.db!.query('SELECT count(*)::int n FROM search_queue')).rows[0]).toEqual({
    n: 1000,
  })
})

it('rejects nonadvancing pages instead of looping or silently missing records', async () => {
  state.snowflake.mockResolvedValue([{ ID: 'not-an-id' }])
  await expect(enqueueFullSearchRepair()).rejects.toThrow('Invalid search repair ID page')
  expect(state.query).not.toHaveBeenCalled()
})
