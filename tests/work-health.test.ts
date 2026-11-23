import { createTestDatabase } from './fixtures/test-database'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'

/**
 * The stall signals of the gateway monitor, read with real SQL from the real queue
 * tables (schema snapshot plus the migrations that created each queue) as the
 * maintenance role the monitor route uses, under forced row-level security.
 */
const state = vi.hoisted(() => ({
  db: null as import('@electric-sql/pglite').PGlite | null,
  inTx: false,
  /** Statements matching this fail, as an unreadable table or a timeout would. */
  fail: null as RegExp | null,
  statements: [] as string[],
}))
vi.mock('@/lib/postgres', () => {
  async function pgTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (state.inTx) return fn()
    const db = state.db!
    await db.exec('BEGIN;SET LOCAL ROLE personal_photos_maintenance')
    state.inTx = true
    try {
      const result = await fn()
      await db.exec('COMMIT')
      return result
    } catch (error) {
      await db.exec('ROLLBACK')
      throw error
    } finally {
      state.inTx = false
    }
  }
  const pgQuery = (sql: string, params: unknown[] = []) =>
    pgTransaction(async () => {
      state.statements.push(sql)
      if (state.fail?.test(sql)) throw new Error('permission denied for table secret_table')
      return (await state.db!.query(sql, params)).rows
    })
  return {
    pgQuery,
    pgTransaction,
    pgQueryOne: async (sql: string, params?: unknown[]) => (await pgQuery(sql, params))[0] ?? null,
  }
})
vi.mock('@/lib/snowflake', () => ({
  getSecret: () => 'ab'.repeat(32),
  SecretType: { GENERIC_STRING: 'GENERIC_STRING' },
}))
import { readWorkHealth, WORK_COUNT_LIMIT, WORK_KINDS } from '@/lib/database/postgres-health'
import { GET } from '@/app/api/health/monitor/route'
import { EmailAlerts } from '../cloudflare-gateway/alerts.mjs'

const exec = (sql: string) => state.db!.exec(sql)
const read = (appConvertsVideo = false) => readWorkHealth({ appConvertsVideo })
const none = {
  oldestEligibleSeconds: null,
  activeLeases: 0,
  expiredLeases: 0,
  oldestExpiredLeaseSeconds: null,
  startingSeconds: null,
  workerSeenSeconds: null,
}
/** Ages are measured against the database clock, a moment after the rows were seeded. */
const about = (value: number | null | undefined, expected: number) => {
  expect(value).toBeGreaterThanOrEqual(expected)
  expect(value).toBeLessThan(expected + 20)
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ago = (interval: string) => `now()-interval '${interval}'`

beforeAll(async () => {
  state.db = await createTestDatabase({
    extensions: true,
    roles: [
      'snowflake_admin',
      'personal_photos_app NOINHERIT',
      'personal_photos_reader',
      'personal_photos_video_worker',
      'personal_photos_maintenance',
    ],
    steps: [
      {
        sql: `SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app,personal_photos_maintenance;
 GRANT SELECT,INSERT,UPDATE,DELETE ON events,photos TO personal_photos_app;`,
      },
      'setup/72-app-rls.sql',
      '202610062030_gateway_security',
      '202610072000_people_faces',
      '202610212100_search_sessions',
      { transaction: ['202610212110_search_enrichment'] },
      { transaction: ['202610212120_search_batch_completion'] },
      { transaction: ['202610242230_upload_routing'] },
      { transaction: ['202610242350_upload_processing_queue'] },
      { transaction: ['202610290210_background_coordination'] },
      { transaction: ['202610292030_photo_ai_admission'] },
      { transaction: ['202611081520_upload_failure_timestamp'] },
      '202611212100_worker_launch_recovery',
      '202611212200_automatic_media_work',
      '202611212300_worker_warm_idle',
      '202611220100_worker_cycle_recovery',
    ],
  })
}, 120000)
afterAll(async () => {
  await state.db?.close()
})
beforeEach(async () => {
  state.fail = null
  state.statements = []
  vi.unstubAllEnvs()
  await exec(`RESET ROLE;
 TRUNCATE upload_processing_jobs, upload_sessions, background_coordinator, face_scan_queue, face_scan_runs,
  video_playback, video_preparation_runs, search_batch_runs, photo_ai_tenant_admission, photos, events
  RESTART IDENTITY CASCADE;
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility)
  VALUES(1,1,'Album','private-folder','ALICE','PRIVATE');`)
})

/** Photos are described, scanned and indexed already unless a test says otherwise. */
async function photos(rows: string) {
  await exec(`INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path,
   display_stage_path,ai_description,ai_attempts,ai_next_attempt_at,ai_claim,ai_lease_until) VALUES ${rows};
  TRUNCATE face_scan_queue, search_enrichment, search_queue, automatic_work_signals;`)
}

it('reports nothing to do, and no coordinator, on an empty database', async () => {
  expect(await read()).toEqual({
    coordinatorHeartbeatSeconds: null,
    uploads: none,
    video: none,
    faces: none,
    ai: none,
    search: { ...none, activeLeases: null, expiredLeases: null },
  })
  // Each read is one bounded statement in its own time-limited transaction.
  expect(state.statements.filter((sql) => /statement_timeout = '1500ms'/.test(sql))).toHaveLength(6)
  for (const sql of state.statements.filter((s) => !/statement_timeout/.test(s)))
    expect(sql).toMatch(/LIMIT 1\b|FROM background_coordinator WHERE name=/)
})

it('measures the coordinator heartbeat from its thirty-second lease', async () => {
  await exec(`INSERT INTO background_coordinator(name,owner,lease_until)
   VALUES('application-background','${uuid(1)}',now()+interval '25 seconds')`)
  about((await read())!.coordinatorHeartbeatSeconds, 5)
  // Stopped twelve minutes ago: the lease ran out thirty seconds after the last renewal.
  await exec(`UPDATE background_coordinator SET lease_until=${ago('690 seconds')}`)
  about((await read())!.coordinatorHeartbeatSeconds, 720)
})

describe('uploads', () => {
  const job = (n: number, columns: string, values: string) =>
    `INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES('${uuid(n)}','ALICE',1);
     INSERT INTO upload_processing_jobs(upload_id,owner,body,caller,auth_epoch,${columns})
     VALUES('${uuid(n)}','ALICE','{"fileName":"private-name.jpg"}','{"username":"ALICE"}','1',${values});`

  it('ages the oldest runnable job and counts live and expired claims', async () => {
    await exec(
      job(1, 'state,next_attempt', `'queued',${ago('20 minutes')}`) +
        job(2, 'state,next_attempt', `'queued',${ago('3 minutes')}`) +
        job(3, 'state,lease_token,lease_until', `'processing','${uuid(3)}',${ago('10 minutes')}`) +
        job(4, 'state,lease_token,lease_until', `'processing','${uuid(4)}',${ago('2 minutes')}`) +
        job(
          5,
          'state,lease_token,lease_until',
          `'processing','${uuid(5)}',now()+interval '4 minutes'`,
        ),
    )
    const { uploads } = (await read())!
    about(uploads!.oldestEligibleSeconds, 1200)
    about(uploads!.oldestExpiredLeaseSeconds, 600)
    expect(uploads).toMatchObject({
      activeLeases: 1,
      expiredLeases: 2,
      startingSeconds: null,
      workerSeenSeconds: null,
    })
  })

  it('ignores jobs waiting for a retry time and jobs that are finished or failed', async () => {
    await exec(
      job(1, 'state,attempts,next_attempt', `'queued',2,now()+interval '4 minutes'`) +
        job(2, 'state,next_attempt', `'failed',${ago('3 hours')}`) +
        job(3, 'state,next_attempt', `'done',${ago('3 hours')}`),
    )
    expect((await read())!.uploads).toEqual(none)
  })

  it('stops counting at the limit', async () => {
    await exec(`INSERT INTO upload_sessions(upload_id,owner,total_chunks)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'ALICE',1 FROM generate_series(1,${WORK_COUNT_LIMIT + 5}) n;
     INSERT INTO upload_processing_jobs(upload_id,owner,body,caller,auth_epoch,state,lease_token,lease_until)
      SELECT upload_id,'ALICE','{}','{}','1','processing',upload_id,${ago('1 hour')} FROM upload_sessions;`)
    expect((await read())!.uploads!.expiredLeases).toBe(WORK_COUNT_LIMIT)
  })
})

describe('face scan', () => {
  const queue = (
    photo: number,
    status: string,
    run: string | null,
    next: string,
    lease: string | null = null,
  ) =>
    `INSERT INTO face_scan_queue(photo_id,owner_username,source_path,status,run_id,next_attempt_at,claim_token,lease_until)
     VALUES(${photo},'ALICE','private/path-${photo}','${status}',${run ? `'${run}'` : 'NULL'},${next},
       ${lease ? `'${uuid(photo)}'` : 'NULL'},${lease ?? 'NULL'});`
  const run = (n: number, status: string, created: string, heartbeat: string) =>
    `INSERT INTO face_scan_runs(id,requested_by,kind,status,photo_limit,created_at,heartbeat_at)
     VALUES('${uuid(n)}','ALICE','backfill','${status}',100,${created},${heartbeat});`

  it('counts only work the active run admitted, and reports its heartbeat', async () => {
    await exec(
      run(1, 'cancelled', ago('5 hours'), ago('4 hours')) +
        run(2, 'running', ago('1 hour'), ago('400 seconds')) +
        // Parked: no run, and a stopped run's leftovers (one still marked as claimed).
        queue(1, 'queued', null, ago('9 hours')) +
        queue(2, 'queued', uuid(1), ago('8 hours')) +
        queue(3, 'running', uuid(1), ago('8 hours'), ago('4 hours')) +
        // The active run: runnable, backing off, exhausted, expired claim, live claim.
        queue(4, 'queued', uuid(2), ago('700 seconds')) +
        queue(5, 'queued', uuid(2), "now()+interval '20 seconds'") +
        queue(6, 'failed', uuid(2), ago('2 hours')) +
        queue(7, 'running', uuid(2), ago('1 hour'), ago('300 seconds')) +
        queue(8, 'running', uuid(2), ago('1 hour'), "now()+interval '3 minutes'"),
    )
    const { faces } = (await read())!
    about(faces!.oldestEligibleSeconds, 700)
    about(faces!.oldestExpiredLeaseSeconds, 300)
    about(faces!.workerSeenSeconds, 400)
    expect(faces).toMatchObject({ activeLeases: 1, expiredLeases: 1, startingSeconds: null })
  })

  it('reports a launched run as starting, not as a silent worker', async () => {
    await exec(
      run(1, 'starting', ago('12 minutes'), ago('12 minutes')) +
        queue(1, 'queued', uuid(1), ago('12 minutes')),
    )
    const { faces } = (await read())!
    about(faces!.startingSeconds, 720)
    about(faces!.oldestEligibleSeconds, 720)
    expect(faces!.workerSeenSeconds).toBeNull()
  })

  it('reports nothing when queued photos have no active run', async () => {
    await exec(
      run(1, 'attention', ago('5 hours'), ago('4 hours')) +
        queue(1, 'queued', uuid(1), ago('5 hours')) +
        queue(2, 'queued', null, ago('5 hours')),
    )
    expect((await read())!.faces).toEqual(none)
  })
})

describe('video preparation', () => {
  const seed = async () => {
    await photos(`(1,1,'a.mov','video','READY','o/1','d/1','x',0,now(),NULL,NULL),
      (2,1,'b.mov','video','READY','o/2','d/2','x',0,now(),NULL,NULL),
      (3,1,'c.mov','video','READY','o/3-replaced','d/3','x',0,now(),NULL,NULL),
      (4,1,'d.mov','video','READY','o/4','d/4','x',0,now(),NULL,NULL),
      (5,1,'e.mov','video','READY','o/5','d/5','x',0,now(),NULL,NULL),
      (6,1,'f.mov','video','READY','o/6','d/6','x',0,now(),NULL,NULL)`)
    await exec(`TRUNCATE video_playback;
     INSERT INTO video_preparation_runs(id,requested_by,status,created_at,heartbeat_at)
      VALUES('${uuid(1)}','ALICE','running',${ago('40 minutes')},${ago('90 seconds')});
     INSERT INTO video_playback(photo_id,original_path,status,preparation_run_id,next_attempt_at,claim_token,lease_until) VALUES
      (1,'o/1','queued','${uuid(1)}',${ago('500 seconds')},NULL,NULL),
      (2,'o/2','queued',NULL,${ago('2 hours')},NULL,NULL),
      (3,'o/3','queued','${uuid(1)}',${ago('3 hours')},NULL,NULL),
      (4,'o/4','queued','${uuid(1)}',now()+interval '30 seconds',NULL,NULL),
      (5,'o/5','running','${uuid(1)}',${ago('1 hour')},'${uuid(5)}',${ago('240 seconds')}),
      (6,'o/6','running',NULL,${ago('1 hour')},'${uuid(6)}',${ago('50 minutes')});`)
  }

  it('counts only the active run, skipping backoff and a replaced original', async () => {
    await seed()
    const { video } = (await read())!
    about(video!.oldestEligibleSeconds, 500)
    about(video!.oldestExpiredLeaseSeconds, 240)
    about(video!.workerSeenSeconds, 90)
    expect(video).toMatchObject({ activeLeases: 0, expiredLeases: 1, startingSeconds: null })
  })

  it('counts every queued video when the application converts videos itself', async () => {
    await seed()
    const { video } = (await read(true))!
    about(video!.oldestEligibleSeconds, 7200)
    about(video!.oldestExpiredLeaseSeconds, 3000)
    expect(video!.expiredLeases).toBe(2)
  })

  it('reports nothing for videos that no run has admitted', async () => {
    await seed()
    await exec("UPDATE video_preparation_runs SET status='attention'")
    expect((await read())!.video).toEqual(none)
  })
})

describe('photo descriptions', () => {
  it('ages the oldest claimable photo, excluding backoff, exhausted and non-photo rows', async () => {
    await photos(`
      (1,1,'ready.jpg','photo','READY','o/1','d/1',NULL,0,${ago('50 minutes')},NULL,NULL),
      (2,1,'backoff.jpg','photo','READY','o/2','d/2',NULL,1,now()+interval '5 minutes',NULL,NULL),
      (3,1,'exhausted.jpg','photo','READY','o/3','d/3',NULL,3,${ago('9 hours')},NULL,NULL),
      (4,1,'clip.mov','video','READY','o/4','d/4',NULL,0,${ago('9 hours')},NULL,NULL),
      (5,1,'ingesting.jpg','photo','PROCESSING','o/5','d/5',NULL,0,${ago('9 hours')},NULL,NULL),
      (6,1,'no-display.jpg','photo','READY','o/6',NULL,NULL,0,${ago('9 hours')},NULL,NULL),
      (7,1,'claimed.jpg','photo','READY','o/7','d/7',NULL,1,${ago('9 hours')},'${uuid(7)}',now()+interval '10 minutes'),
      (8,1,'abandoned.jpg','photo','READY','o/8','d/8',NULL,1,${ago('20 minutes')},'${uuid(8)}',${ago('5 minutes')}),
      (9,1,'done.jpg','photo','READY','o/9','d/9','A described photo',1,${ago('9 hours')},NULL,NULL)`)
    await exec(`INSERT INTO photo_ai_tenant_admission(owner_username,last_claimed_at,claim_sequence,window_start,attempts)
      VALUES('ALICE',${ago('3 hours')},1,now(),1),('BOB',${ago('8 minutes')},2,now(),1)`)
    const { ai } = (await read())!
    about(ai!.oldestEligibleSeconds, 3000)
    about(ai!.oldestExpiredLeaseSeconds, 300)
    about(ai!.workerSeenSeconds, 480)
    expect(ai).toMatchObject({ activeLeases: 1, expiredLeases: 1, startingSeconds: null })
  })

  it('reports nothing when every remaining photo is backing off or exhausted', async () => {
    await photos(`
      (1,1,'backoff.jpg','photo','READY','o/1','d/1',NULL,2,now()+interval '10 minutes',NULL,NULL),
      (2,1,'exhausted.jpg','photo','READY','o/2','d/2',NULL,3,${ago('9 hours')},NULL,NULL)`)
    expect((await read())!.ai).toEqual(none)
  })
})

describe('search enrichment', () => {
  const seed = async (status: string, ids: string) => {
    await photos(`(1,1,'a.jpg','photo','READY','o/1','d/1','x',0,now(),NULL,NULL),
      (2,1,'b.jpg','photo','READY','o/2','d/2','x',0,now(),NULL,NULL),
      (3,1,'c.jpg','photo','READY','o/3','d/3','x',0,now(),NULL,NULL)`)
    await exec(`INSERT INTO search_enrichment(photo_id,source_path,status,attempts,updated_at) VALUES
      (1,'o/1','queued',0,${ago('15 minutes')}),(2,'o/2','queued',0,${ago('6 hours')}),(3,'o/3','queued',3,${ago('6 hours')});
     TRUNCATE automatic_work_signals;
     INSERT INTO search_batch_runs(id,requested_by,status,created_at,heartbeat_at,automatic_photo_ids)
      VALUES('${uuid(1)}','ALICE','${status}',${ago('25 minutes')},${ago('200 seconds')},${ids});`)
  }

  it('ages the photos an automatic run admitted and reports its heartbeat', async () => {
    await seed('running', "'{1,3}'")
    const { search } = (await read())!
    about(search!.oldestEligibleSeconds, 900)
    about(search!.workerSeenSeconds, 200)
    expect(search).toMatchObject({ activeLeases: null, expiredLeases: null, startingSeconds: null })
  })

  it('reports a manual run by its heartbeat alone, and a launched run as starting', async () => {
    await seed('running', 'NULL')
    expect((await read())!.search!.oldestEligibleSeconds).toBeNull()
    about((await read())!.search!.workerSeenSeconds, 200)
    await exec("UPDATE search_batch_runs SET status='starting'")
    about((await read())!.search!.startingSeconds, 1500)
    expect((await read())!.search!.workerSeenSeconds).toBeNull()
  })

  it('reports nothing for queued photos when no run is active', async () => {
    await seed('cancelled', "'{1,2}'")
    expect((await read())!.search).toEqual({ ...none, activeLeases: null, expiredLeases: null })
  })
})

describe('failure and disclosure', () => {
  function request() {
    const stamp = String(Date.now())
    return new Request('https://origin/api/health/monitor', {
      headers: {
        'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY',
        'x-photo-monitor-time': stamp,
        'x-photo-monitor-signature': createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex'))
          .update('photo-monitor-v1:' + stamp)
          .digest('hex'),
      },
    })
  }
  const monitor = async () => (await GET(request())).json()

  it('leaves out only the kind that cannot be read', async () => {
    state.fail = /FROM face_scan_runs/
    const health = (await read())!
    expect(Object.keys(health).sort()).toEqual(
      ['coordinatorHeartbeatSeconds', ...WORK_KINDS.filter((kind) => kind !== 'faces')].sort(),
    )
    state.fail = /background_coordinator/
    expect('coordinatorHeartbeatSeconds' in (await read())!).toBe(false)
    expect((await read())!.faces).toEqual(none)
  })

  it('rejects a result that is not a complete set of non-negative whole numbers', async () => {
    const spy = vi.spyOn(await import('@/lib/postgres'), 'pgQueryOne')
    for (const row of [
      { bytes: '123', failed: 4 },
      { eligible: -1, active: 0, expired: 0, expired_age: null, starting: null, seen: null },
      { eligible: 'ALICE', active: 0, expired: 0, expired_age: null, starting: null, seen: null },
      { eligible: 1.5, active: 0, expired: 0, expired_age: null, starting: null, seen: null },
      { heartbeat: 'soon' },
    ]) {
      spy.mockResolvedValue(row)
      expect(await read()).toBeNull()
    }
    spy.mockRestore()
    expect(await read()).not.toBeNull()
  })

  it('reports the database as healthy without stall signals when their read fails', async () => {
    await exec(`INSERT INTO background_coordinator(name,owner,lease_until)
     VALUES('application-background','${uuid(1)}',now()+interval '30 seconds')`)
    const healthy = await monitor()
    expect(healthy).toMatchObject({ database: true, failedUploadsLastHour: 0 })
    expect(Object.keys(healthy.workHealth).sort()).toEqual(
      ['coordinatorHeartbeatSeconds', ...WORK_KINDS].sort(),
    )
    state.fail = /statement_timeout/
    const degraded = await monitor()
    expect(degraded).toMatchObject({ database: true, failedUploadsLastHour: 0 })
    expect('workHealth' in degraded).toBe(false)
    expect(JSON.stringify(degraded)).not.toMatch(/secret_table|permission/)
    // The database signal itself still fails closed.
    state.fail = /pg_database_size/
    expect(await monitor()).toEqual({ database: false })
  })

  it('alerts on the third check for queued uploads nobody is processing and a stopped coordinator, then recovers', async () => {
    // Forty minutes ago an upload was queued and the worker and coordinator both stopped.
    await exec(`INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES('${uuid(1)}','ALICE',1);
     INSERT INTO upload_processing_jobs(upload_id,owner,body,caller,auth_epoch,next_attempt)
      VALUES('${uuid(1)}','ALICE','{"fileName":"private-name.jpg"}','{}','1',${ago('40 minutes')});
     INSERT INTO background_coordinator(name,owner,lease_until)
      VALUES('application-background','${uuid(2)}',${ago('40 minutes')});`)
    const stored = new Map<string, unknown>()
    const emails: { subject: string; body: string }[] = []
    const alerts = new EmailAlerts(
      {
        storage: {
          get: async (key: string) => stored.get(key),
          put: async (key: string, value: unknown) => stored.set(key, value),
        },
      },
      {
        GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
        SNOWFLAKE_ORIGIN: 'https://example.snowflakecomputing.app',
        PG_STORAGE_WARNING_BYTES: '999999999999',
        GATEWAY_TOKENS: {
          idFromName: () => 1,
          get: () => ({
            fetch: async (url: string) =>
              url.endsWith('/token')
                ? new Response('test')
                : Response.json({ expiresAt: Date.now() + 10 * 86400000 }),
          }),
        },
      },
    )
    alerts.deliver = async (subject: string, body: string) => {
      emails.push({ subject, body })
      return { accepted: true }
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input) =>
      new URL(String(input)).pathname.endsWith('/live')
        ? Response.json({ status: 'ok' })
        : GET(request()),
    ) as typeof fetch
    /** The next scheduled five-minute check. */
    const check = () => {
      stored.delete('lastCheck')
      return alerts.check()
    }
    try {
      for (let i = 0; i < 2; i++)
        expect(await check()).toMatchObject({
          database: true,
          uploads: true,
          stalledUploads: false,
          coordinator: false,
          stalledFaces: true,
        })
      expect(emails).toEqual([])
      await check()
      expect(emails.map((email) => email.subject).sort()).toEqual([
        'Needs attention: Background coordinator',
        'Needs attention: Stalled upload processing',
      ])
      expect(emails.map((email) => email.body).join('\n')).not.toMatch(/ALICE|private|0000-4000/)
      expect(emails.map((email) => email.body).join('\n')).toMatch(
        /Oldest item ready to run has waited: 40 minutes/,
      )
      // The same incident is not mailed again.
      await check()
      expect(emails).toHaveLength(2)
      // A worker claims the upload and the coordinator renews its lease.
      await exec(`UPDATE upload_processing_jobs SET state='processing',lease_token='${uuid(3)}',lease_until=now()+interval '5 minutes';
       UPDATE background_coordinator SET lease_until=now()+interval '30 seconds';`)
      expect(await check()).toMatchObject({ stalledUploads: true, coordinator: true })
      expect(emails).toHaveLength(2)
      await check()
      expect(
        emails
          .slice(2)
          .map((email) => email.subject)
          .sort(),
      ).toEqual(['Recovered: Background coordinator', 'Recovered: Stalled upload processing'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns numbers only: no names, paths, owners or identifiers', async () => {
    await photos(
      `(1,1,'private-name.jpg','photo','READY','private/original','private/display',NULL,0,${ago('1 hour')},'${uuid(9)}',${ago('1 minute')})`,
    )
    await exec(`INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES('${uuid(1)}','ALICE',1);
     INSERT INTO upload_processing_jobs(upload_id,owner,body,caller,auth_epoch,error)
      VALUES('${uuid(1)}','ALICE','{"fileName":"private-name.jpg"}','{"username":"ALICE"}','1','private error text');
     INSERT INTO background_coordinator(name,owner,lease_until) VALUES('application-background','${uuid(2)}',now());`)
    const { workHealth } = await monitor()
    const leaves: unknown[] = []
    const walk = (value: unknown) => {
      if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
      else leaves.push(value)
    }
    walk(workHealth)
    expect(leaves.length).toBe(1 + WORK_KINDS.length * 6)
    for (const leaf of leaves) expect(leaf === null || Number.isSafeInteger(leaf)).toBe(true)
    expect(JSON.stringify(workHealth)).not.toMatch(/ALICE|private|0000-4000|Album|\.jpg/i)
  })
})
