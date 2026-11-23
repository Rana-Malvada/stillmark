import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  db: null as PGlite | null,
  locks: new Set<string>(),
  command: vi.fn(),
  sync: vi.fn(),
  beforeTransaction: undefined as undefined | (() => Promise<unknown>),
}))
vi.mock('@/lib/postgres', () => ({
  pgQuery: async (sql: string, params?: unknown[]) => (await s.db!.query(sql, params)).rows,
  pgTransaction: async (fn: () => Promise<unknown>) => {
    const before = s.beforeTransaction
    s.beforeTransaction = undefined
    if (before) await before()
    await s.db!.exec('BEGIN')
    try {
      const result = await fn()
      await s.db!.exec('COMMIT')
      return result
    } catch (e) {
      await s.db!.exec('ROLLBACK')
      throw e
    }
  },
  withAdvisoryLock: async (key: string, fn: () => Promise<unknown>) => {
    if (s.locks.has(key)) return null
    s.locks.add(key)
    try {
      return await fn()
    } finally {
      s.locks.delete(key)
    }
  },
}))
vi.mock('@/lib/search/search-batch-control', () => ({ searchBatchCommand: s.command }))
vi.mock('@/lib/search/search-sync', () => ({ syncSearch: s.sync }))
vi.mock('@/lib/search/search-replay', () => ({ refreshSavedSearches: vi.fn() }))
import { acknowledgeAutomaticWork, listAutomaticWork } from '@/lib/automatic-work'
import {
  maintainAutomaticSearch,
  retryAutomaticSearch,
  stopAutomaticSearch,
} from '@/lib/search/automatic-search'
import { maintainSearchBatch, startSearchBatch, stopSearchBatch } from '@/lib/search/search-batch'
import { SEARCH_WORKER_INTERRUPTED } from '@/lib/search/search-ocr-recovery'

beforeAll(async () => {
  s.db = new PGlite()
  await s.db.exec(`CREATE ROLE personal_photos_maintenance;CREATE ROLE personal_photos_app;
 CREATE SCHEMA photo_security;CREATE FUNCTION photo_security.flag(text) RETURNS boolean LANGUAGE SQL AS 'SELECT false';
 CREATE TABLE photos(photo_id int PRIMARY KEY,original_stage_path text,ingest_status text DEFAULT 'READY',media_type text DEFAULT 'photo');
 CREATE TABLE face_scan_queue(photo_id int PRIMARY KEY,source_path text,status text);
 CREATE TABLE video_playback(photo_id int PRIMARY KEY,original_path text,status text);
 CREATE TABLE search_enrichment(photo_id int PRIMARY KEY,source_path text,status text,claim_token uuid,lease_until timestamptz,attempts int DEFAULT 0);
 CREATE TABLE search_queue(kind text,id bigint,revision bigint DEFAULT 1,PRIMARY KEY(kind,id));
 CREATE TABLE search_sessions(id uuid,rerank_status text,expires_at timestamptz,scope_revision bigint,scope_ids int[],username text);
 CREATE FUNCTION search_scope_revision(int[],text) RETURNS bigint LANGUAGE SQL AS 'SELECT 1::bigint';
 CREATE TABLE search_batch_runs(id uuid PRIMARY KEY,requested_by text,status text DEFAULT 'starting',photo_limit int,search_limit int,
 photos_done int DEFAULT 0,failures int DEFAULT 0,elapsed_ms bigint,created_at timestamptz DEFAULT now(),heartbeat_at timestamptz DEFAULT now(),
 finished_at timestamptz,error text,pipeline_error text,continued_by uuid,settled_at timestamptz);
 CREATE UNIQUE INDEX one_search_batch ON search_batch_runs((true)) WHERE status IN ('starting','running');
 INSERT INTO search_enrichment(photo_id,source_path,status) VALUES(999,'old','queued');`)
  await s.db.exec(readFileSync('migrations/postgres/202611212200_automatic_media_work.sql', 'utf8'))
  await s.db.exec(
    'CREATE TABLE face_scan_runs(id uuid PRIMARY KEY);CREATE TABLE video_preparation_runs(id uuid PRIMARY KEY)',
  )
  await s.db.exec(
    readFileSync('migrations/postgres/202611220100_worker_cycle_recovery.sql', 'utf8'),
  )
  expect(await listAutomaticWork('ocr')).toEqual([])
})
afterAll(async () => s.db?.close())
beforeEach(async () => {
  vi.stubEnv('AUTOMATIC_MEDIA_PROCESSING_ENABLED', 'true')
  s.command.mockReset().mockResolvedValue({ status: 'DONE' })
  s.sync.mockReset().mockResolvedValue({ remaining: 0 })
  s.locks.clear()
  s.beforeTransaction = undefined
  await s.db!.exec(
    'TRUNCATE photos,face_scan_queue,video_playback,search_enrichment,search_queue,search_batch_runs,search_sessions,automatic_work_signals,automatic_work_state',
  )
})
async function photo(id: number) {
  await s.db!.exec(
    `INSERT INTO photos(photo_id,original_stage_path) VALUES(${id},'photo${id}');INSERT INTO search_enrichment(photo_id,source_path,status) VALUES(${id},'photo${id}','queued')`,
  )
}
async function queue() {
  await s.db!.exec(
    "INSERT INTO search_queue VALUES('photo',1,1) ON CONFLICT(kind,id) DO UPDATE SET revision=search_queue.revision+1",
  )
}
async function runs() {
  return (await s.db!.query<any>('SELECT * FROM search_batch_runs ORDER BY created_at,id')).rows
}

it('signals only new sources and index revisions, not retries, and separates event/photo IDs', async () => {
  await photo(1)
  const initial = await listAutomaticWork('ocr')
  await s.db!.exec(
    "UPDATE search_enrichment SET status='running';UPDATE search_enrichment SET status='queued'",
  )
  expect(await listAutomaticWork('ocr')).toEqual(initial)
  await s.db!.exec("UPDATE search_enrichment SET source_path='replacement'")
  await acknowledgeAutomaticWork('ocr', initial)
  expect(await listAutomaticWork('ocr')).toHaveLength(1)
  expect((await listAutomaticWork('ocr'))[0].revision).not.toBe(initial[0].revision)
  await s.db!.exec("INSERT INTO search_queue VALUES('photo',1,1),('event',1,1)")
  expect(await listAutomaticWork('search')).toHaveLength(2)
  const before = await listAutomaticWork('search')
  await s.db!.exec('UPDATE search_queue SET revision=revision')
  expect(await listAutomaticWork('search')).toEqual(before)
})
it('rolls signal acknowledgement back with failed durable admission', async () => {
  await photo(1)
  await s.db!.exec('BEGIN')
  await acknowledgeAutomaticWork('ocr', await listAutomaticWork('ocr'))
  await s.db!.exec('ROLLBACK')
  expect(await listAutomaticWork('ocr')).toHaveLength(1)
})
it('idle ticks launch nothing; a committed launch retries the same ID after restart', async () => {
  await maintainSearchBatch()
  await maintainAutomaticSearch()
  expect(s.command).not.toHaveBeenCalled()
  expect(s.sync).not.toHaveBeenCalled()
  await photo(1)
  s.command.mockRejectedValueOnce(new Error('lost launch response'))
  await expect(maintainSearchBatch()).rejects.toThrow('lost launch')
  const [first] = await runs()
  expect(first.automatic_photo_ids).toEqual([1])
  expect(await listAutomaticWork('ocr')).toEqual([])
  await maintainSearchBatch()
  expect(await runs()).toHaveLength(1)
  expect(s.command.mock.calls.map((c) => c[0])).toEqual([first.id, first.id])
})
it.each(['cancelled', 'failed'])(
  'does not rearm %s work, but admits genuinely new uploads separately',
  async (status) => {
    await photo(1)
    await maintainSearchBatch()
    await s.db!.query('UPDATE search_batch_runs SET status=$1,settled_at=now()', [status])
    s.command.mockClear()
    await maintainSearchBatch()
    expect(s.command).not.toHaveBeenCalled()
    await photo(2)
    await maintainSearchBatch()
    expect((await runs()).at(-1).automatic_photo_ids).toEqual([2])
    expect(s.command).toHaveBeenCalledTimes(1)
  },
)
it('parallel ticks create one run, and new uploads join a warm active automatic run', async () => {
  await photo(1)
  await Promise.all([maintainSearchBatch(), maintainSearchBatch()])
  expect(await runs()).toHaveLength(1)
  expect(s.command).toHaveBeenCalledTimes(1)
  await s.db!.exec("UPDATE search_batch_runs SET status='running',idle_since=now()")
  await photo(2)
  s.command.mockClear()
  await maintainSearchBatch()
  expect((await runs())[0].automatic_photo_ids.sort()).toEqual([1, 2])
  expect(s.command).not.toHaveBeenCalled()
})
it('Stop consumes current admission signals without deleting queued work', async () => {
  await photo(1)
  await maintainSearchBatch()
  await photo(2)
  await queue()
  await stopSearchBatch()
  expect(await listAutomaticWork('ocr')).toEqual([])
  expect(await listAutomaticWork('search')).toEqual([])
  s.command.mockClear()
  await maintainSearchBatch()
  await maintainAutomaticSearch()
  expect(s.command.mock.calls.every((c) => c[1] === 'SETTLE')).toBe(true)
  expect(s.sync).not.toHaveBeenCalled()
  expect((await s.db!.query('SELECT * FROM search_enrichment')).rows).toHaveLength(2)
})
it('three-hour OCR expiry does not reset its deadline or restart old queued work', async () => {
  await photo(1)
  await maintainSearchBatch()
  await s.db!.exec(
    "UPDATE search_batch_runs SET created_at=now()-interval '4 hours',settled_at=now()",
  )
  s.command.mockClear()
  await maintainSearchBatch()
  await maintainSearchBatch()
  expect(s.command.mock.calls.map((c) => c[1])).toEqual(['CANCEL'])
  expect(await runs()).toHaveLength(1)
})
it('publishing resumes a durable cycle after restart and finishes bounded batches', async () => {
  await queue()
  s.sync.mockResolvedValueOnce({ remaining: 1 })
  await maintainAutomaticSearch()
  const [before] = (await s.db!.query<any>('SELECT * FROM automatic_work_state')).rows
  expect(before.status).toBe('running')
  await s.db!.exec('DELETE FROM search_queue')
  await maintainAutomaticSearch()
  const [after] = (await s.db!.query<any>('SELECT * FROM automatic_work_state')).rows
  expect(after.run_id).toBe(before.run_id)
  expect(after.status).toBe('completed')
  expect(s.sync).toHaveBeenCalledTimes(2)
})
it('publishing interruptions resume the original cycle without new metadata changes', async () => {
  await queue()
  s.sync.mockRejectedValueOnce(new Error('outage'))
  await expect(maintainAutomaticSearch()).rejects.toThrow('outage')
  await maintainAutomaticSearch()
  expect(s.sync).toHaveBeenCalledTimes(1)
  const before = (await s.db!.query<any>('SELECT * FROM automatic_work_state')).rows[0]
  await s.db!.exec('UPDATE automatic_work_state SET next_attempt_at=now()')
  s.sync.mockResolvedValueOnce({ remaining: 1 })
  await maintainAutomaticSearch()
  const after = (await s.db!.query<any>('SELECT * FROM automatic_work_state')).rows[0]
  expect(after.run_id).toBe(before.run_id)
  expect(after.deadline).toEqual(before.deadline)
  expect(after.status).toBe('running')
  expect(after.retry_attempts).toBe(0)
  expect(after.error).toBeNull()
  expect(s.sync).toHaveBeenCalledTimes(2)
})
it('publishing deadline and explicit Stop do not automatically retry paid work', async () => {
  await queue()
  s.sync.mockResolvedValue({ remaining: 1 })
  await maintainAutomaticSearch()
  await s.db!.exec("UPDATE automatic_work_state SET deadline=now()-interval '1 second'")
  await maintainAutomaticSearch()
  await maintainAutomaticSearch()
  expect(s.sync).toHaveBeenCalledTimes(1)
  await queue()
  await maintainAutomaticSearch()
  await stopAutomaticSearch()
  await maintainAutomaticSearch()
  expect(s.sync).toHaveBeenCalledTimes(2)
})
it('stale signals and concurrent publishing ticks do not launch empty or duplicate work', async () => {
  await queue()
  await s.db!.exec('DELETE FROM search_queue')
  await maintainAutomaticSearch()
  expect(s.sync).not.toHaveBeenCalled()
  await queue()
  await Promise.all([maintainAutomaticSearch(), maintainAutomaticSearch()])
  expect(s.sync).toHaveBeenCalledTimes(1)
})

it('an in-flight publishing completion cannot undo Stop or consume later work', async () => {
  await queue()
  let complete!: (value: { remaining: number }) => void
  s.sync.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const running = maintainAutomaticSearch()
  await vi.waitFor(() => expect(s.sync).toHaveBeenCalledTimes(1))
  await stopAutomaticSearch()
  await queue()
  complete({ remaining: 0 })
  await running
  expect((await s.db!.query<any>('SELECT status FROM automatic_work_state')).rows[0].status).toBe(
    'cancelled',
  )
  expect(await listAutomaticWork('search')).toHaveLength(1)
})

it('the actual worker claim SQL excludes old backlog for automatic runs but preserves manual claims', async () => {
  await s.db!.exec(
    'ALTER TABLE search_enrichment ADD COLUMN IF NOT EXISTS claim_token uuid, ADD COLUMN IF NOT EXISTS lease_until timestamptz, ADD COLUMN IF NOT EXISTS attempts int DEFAULT 0',
  )
  await photo(1)
  await photo(2)
  await acknowledgeAutomaticWork(
    'ocr',
    (await listAutomaticWork('ocr')).filter((s) => s.sourceId === 1),
  )
  await maintainSearchBatch()
  const [run] = await runs()
  await s.db!.exec("UPDATE search_batch_runs SET status='running'")
  // The search worker is a Python program and cannot run here, so its claim statement is read
  // from its source and run in PostgreSQL. This pins the contract between the two: the exact
  // SQL the worker sends claims only the photos its batch run was given.
  const source = readFileSync('workers/search-cpu/worker.py', 'utf8')
  const actual = source.match(
    /row = db.execute\("""(UPDATE search_enrichment SET status='running'[\s\S]*?)"""/,
  )![1]
  let parameter = 0
  const sql = actual.replace(/%s/g, () => '$' + ++parameter)
  const claimed = (await s.db!.query<any>(sql, [300, run.id, run.id])).rows
  expect(claimed.map((r) => r.photo_id)).toEqual([2])
  expect((await s.db!.query<any>(sql, [300, run.id, run.id])).rows).toEqual([])
  await s.db!.exec('UPDATE search_batch_runs SET automatic_photo_ids=NULL')
  expect((await s.db!.query<any>(sql, [300, run.id, run.id])).rows.map((r) => r.photo_id)).toEqual([
    1,
  ])
})

it('explicit publishing retry is durable, idempotent and does not publish in the request', async () => {
  await queue()
  s.sync.mockRejectedValueOnce(new Error('offline'))
  await expect(maintainAutomaticSearch()).rejects.toThrow('offline')
  await s.db!.exec("UPDATE automatic_work_state SET status='failed'")
  const first = await retryAutomaticSearch()
  const second = await retryAutomaticSearch()
  expect(second.id).toBe(first.id)
  expect(s.sync).toHaveBeenCalledTimes(1)
  await maintainAutomaticSearch()
  expect(s.sync).toHaveBeenCalledTimes(2)
  await expect(retryAutomaticSearch()).rejects.toMatchObject({ status: 409 })
})

it('Stop winning before publishing admission cannot be undone by a stale wake snapshot', async () => {
  await queue()
  s.beforeTransaction = () => stopAutomaticSearch()
  await maintainAutomaticSearch()
  expect(s.sync).not.toHaveBeenCalled()
  expect(await listAutomaticWork('search')).toEqual([])
  expect(
    (await s.db!.query<any>('SELECT status FROM automatic_work_state')).rows[0].status,
  ).not.toBe('running')
})
it('a recent OCR child near the root deadline retains new-upload signals for a later cycle', async () => {
  await photo(1)
  await maintainSearchBatch()
  const [root] = await runs()
  const child = '00000000-0000-4000-8000-000000000001'
  await s.db!.query(
    "UPDATE search_batch_runs SET status='completed',created_at=now()-interval '2 hours 59 minutes 30 seconds',continued_by=$1,settled_at=now() WHERE id=$2",
    [child, root.id],
  )
  await s.db!.query(
    "INSERT INTO search_batch_runs(id,requested_by,photo_limit,search_limit,automatic_photo_ids,settled_at) VALUES($1,'automatic',1,0,ARRAY[1],now())",
    [child],
  )
  await photo(2)
  s.command.mockClear()
  await maintainSearchBatch()
  expect((await listAutomaticWork('ocr')).map((s) => s.sourceId)).toEqual([2])
  expect(s.command.mock.calls.map((c) => c[1])).toEqual(['CANCEL'])
  expect((await runs()).find((r) => r.id === child).automatic_photo_ids).toEqual([1])
})
it('a capped manual OCR run preserves automatic signals until durable automatic admission', async () => {
  await photo(1)
  await photo(2)
  await startSearchBatch('owner', 1, 0)
  expect((await listAutomaticWork('ocr')).map((s) => s.sourceId)).toEqual([1, 2])
  expect((await runs())[0].automatic_photo_ids).toBeNull()
})

it('Stop from another request aborts the active publishing signal', async () => {
  await queue()
  let signal!: AbortSignal
  let complete!: (value: { remaining: number }) => void
  s.sync.mockImplementationOnce((options) => {
    signal = options.signal
    return new Promise((resolve) => {
      complete = resolve
    })
  })
  vi.useFakeTimers()
  try {
    const running = maintainAutomaticSearch()
    await vi.waitFor(() => expect(s.sync).toHaveBeenCalledTimes(1))
    await stopAutomaticSearch()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    complete({ remaining: 0 })
    await running
  } finally {
    vi.useRealTimers()
  }
})

async function interruptLatest() {
  await s.db!.query(
    "UPDATE search_batch_runs SET status='failed',error=$1,finished_at=now()-interval '3 minutes',settled_at=now() WHERE continued_by IS NULL",
    [SEARCH_WORKER_INTERRUPTED],
  )
}
it('recovers admitted OCR after a crash without new signals and retries one committed successor after lost launch acknowledgement', async () => {
  await photo(1)
  await photo(2)
  await maintainSearchBatch()
  const [root] = await runs()
  await s.db!.exec(
    "UPDATE search_enrichment SET status='running',attempts=1,claim_token=gen_random_uuid(),lease_until=now()-interval '1 second' WHERE photo_id=1",
  )
  await interruptLatest()
  s.command.mockRejectedValueOnce(new Error('lost successor launch acknowledgement'))
  await expect(maintainSearchBatch()).rejects.toThrow('lost successor')
  const chain = await runs()
  expect(chain).toHaveLength(2)
  const child = chain.find((row) => row.id !== root.id)
  expect(child.automatic_photo_ids).toEqual([1, 2])
  expect(chain.find((row) => row.id === root.id).continued_by).toBe(child.id)
  expect(await listAutomaticWork('ocr')).toEqual([])
  await maintainSearchBatch()
  expect(await runs()).toHaveLength(2)
  expect(s.command.mock.calls.slice(-2).map((call) => call[0])).toEqual([child.id, child.id])
  expect(s.command.mock.calls.at(-1)![2]).toBe(new Date(root.created_at).getTime() + 10800000)
  expect(
    (await s.db!.query<any>('SELECT attempts,status FROM search_enrichment WHERE photo_id=1'))
      .rows[0],
  ).toMatchObject({ attempts: 1, status: 'queued' })
})
it('waits for live claims and backoff without allowing a later upload to eclipse recovery', async () => {
  await photo(1)
  await maintainSearchBatch()
  await interruptLatest()
  await s.db!.exec(
    "UPDATE search_enrichment SET status='running',attempts=1,claim_token=gen_random_uuid(),lease_until=now()+interval '5 minutes'",
  )
  await photo(2)
  await maintainSearchBatch()
  expect(await runs()).toHaveLength(1)
  expect((await listAutomaticWork('ocr')).map((row) => row.sourceId)).toEqual([2])
  await s.db!.exec(
    "UPDATE search_enrichment SET lease_until=now()-interval '1 second' WHERE photo_id=1;UPDATE search_batch_runs SET finished_at=now()",
  )
  await maintainSearchBatch()
  expect(await runs()).toHaveLength(1)
})
it('Stop cancels an infrastructure recovery waiting for its successor', async () => {
  await photo(1)
  await maintainSearchBatch()
  await interruptLatest()
  await stopSearchBatch()
  await maintainSearchBatch()
  expect(await runs()).toHaveLength(1)
  expect((await runs())[0].status).toBe('cancelled')
})
it('infrastructure continuations never reset the original three-hour deadline or crash allowance', async () => {
  await photo(1)
  await maintainSearchBatch()
  for (let attempt = 0; attempt < 4; attempt++) {
    await interruptLatest()
    await maintainSearchBatch()
  }
  expect(await runs()).toHaveLength(4)
  await s.db!.exec('TRUNCATE search_batch_runs')
  await photo(2)
  await maintainSearchBatch()
  await interruptLatest()
  await s.db!.exec("UPDATE search_batch_runs SET created_at=now()-interval '4 hours'")
  await maintainSearchBatch()
  expect(await runs()).toHaveLength(1)
})
it('does not reset exhausted item attempts or retry terminal media failure', async () => {
  await photo(1)
  await photo(2)
  await maintainSearchBatch()
  await interruptLatest()
  await s.db!.exec(
    "UPDATE search_enrichment SET status='running',attempts=3,lease_until=now()-interval '1 second' WHERE photo_id=1;UPDATE search_enrichment SET status='failed',attempts=3 WHERE photo_id=2",
  )
  await maintainSearchBatch()
  expect(await runs()).toHaveLength(1)
  expect((await s.db!.query<any>('SELECT status,attempts FROM search_enrichment')).rows).toEqual([
    { status: 'failed', attempts: 3 },
    { status: 'failed', attempts: 3 },
  ])
})

it('retains automatic signals across manual-worker interruption and admits only after its claim expires', async () => {
  await photo(1)
  await startSearchBatch('owner', 1, 0)
  await s.db!.exec(
    "UPDATE search_batch_runs SET status='failed',settled_at=now();UPDATE search_enrichment SET status='running',attempts=1,claim_token=gen_random_uuid(),lease_until=now()+interval '5 minutes'",
  )
  await maintainSearchBatch()
  expect(await runs()).toHaveLength(1)
  expect((await listAutomaticWork('ocr')).map((row) => row.sourceId)).toEqual([1])
  await s.db!.exec("UPDATE search_enrichment SET lease_until=now()-interval '1 second'")
  await maintainSearchBatch()
  expect(await runs()).toHaveLength(2)
  expect((await runs()).at(-1).automatic_photo_ids).toEqual([1])
  expect(await listAutomaticWork('ocr')).toEqual([])
  expect((await s.db!.query<any>('SELECT attempts FROM search_enrichment')).rows[0].attempts).toBe(
    1,
  )
})

it.each([false, true])(
  'manual Stop consumes retained automatic signals and cannot rearm after lease expiry (claimed=%s)',
  async (claimed) => {
    await photo(1)
    await startSearchBatch('owner', 1, 0)
    if (claimed)
      await s.db!.exec(
        "UPDATE search_enrichment SET status='running',attempts=1,claim_token=gen_random_uuid(),lease_until=now()+interval '5 minutes'",
      )
    await stopSearchBatch()
    expect(await listAutomaticWork('ocr')).toEqual([])
    if (claimed)
      await s.db!.exec("UPDATE search_enrichment SET lease_until=now()-interval '1 second'")
    await maintainSearchBatch()
    expect(await runs()).toHaveLength(1)
    expect((await runs())[0].status).toBe('cancelled')
  },
)
