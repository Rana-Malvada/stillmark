import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { photoAiAdmission } from '@/lib/photos/photo-ai-admission'

let db: PGlite
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`CREATE ROLE personal_photos_maintenance; CREATE ROLE personal_photos_app;
 CREATE TABLE events(event_id int PRIMARY KEY,owner_username text NOT NULL);
 CREATE TABLE photos(photo_id int PRIMARY KEY,event_id int REFERENCES events,display_stage_path varchar(1024),file_hash varchar(64),
 ai_description text,ai_attempts int DEFAULT 0,ai_claim uuid,ai_lease_until timestamptz,
 ai_next_attempt_at timestamptz DEFAULT now(),ingest_status text DEFAULT 'READY',media_type text DEFAULT 'photo');
 GRANT SELECT,UPDATE ON photos TO personal_photos_maintenance; GRANT SELECT ON events TO personal_photos_maintenance;
 CREATE SCHEMA photo_security; GRANT USAGE ON SCHEMA photo_security TO personal_photos_maintenance;
 CREATE TABLE gallery_main_admins(username text PRIMARY KEY);
 CREATE TABLE gallery_access_objects(kind text,name text,marker uuid PRIMARY KEY);
 CREATE TABLE photo_security.app_roles(role_key text PRIMARY KEY,profile text);
 CREATE TABLE photo_security.app_memberships(marker uuid,role_key text,PRIMARY KEY(marker,role_key));
 INSERT INTO photo_security.app_roles VALUES('viewer','viewer'),('member','viewer'),('admin','admin'),
 ('admin_readonly','admin_readonly'),('administrator','app_owner'),('access_manager',NULL);`)
  await db.exec(readFileSync('migrations/postgres/202610292030_photo_ai_admission.sql', 'utf8'))
  await db.exec(readFileSync('migrations/postgres/202611212350_photo_ai_claim_types.sql', 'utf8'))
  await db.exec(
    readFileSync('migrations/postgres/202611220200_photo_ai_member_hourly_limit.sql', 'utf8'),
  )
  await db.exec(
    readFileSync('migrations/postgres/202611220500_drop_photo_ai_member_allowance.sql', 'utf8'),
  )
})
afterAll(async () => db.close())
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
  await db.exec(`RESET ROLE; TRUNCATE photos,events,photo_ai_tenant_admission,gallery_main_admins,gallery_access_objects,photo_security.app_memberships;
 UPDATE photo_ai_admission SET attempts=0,window_start=date_trunc('hour',now());
 INSERT INTO events VALUES(1,'A'),(2,'B'),(3,'C');
 INSERT INTO photos(photo_id,event_id,display_stage_path,file_hash)
 SELECT n,CASE WHEN n<=10 THEN 1 WHEN n<=20 THEN 2 ELSE 3 END,'display/'||n,'hash'||n FROM generate_series(1,30)n;
 SET ROLE personal_photos_maintenance;`)
})
const claim = async (fleet = 3, tenant = 1, hour = 100, tenantHour = 100) =>
  (
    await db.query<{ photo_id: number }>('SELECT * FROM claim_photo_ai($1,$2,$3,$4,$5)', [
      randomUUID(),
      fleet,
      tenant,
      hour,
      tenantHour,
    ])
  ).rows
it('gives every owner the same per-owner hourly allowance', async () => {
  const ids: number[] = []
  for (let i = 0; i < 12; i++)
    ids.push(...(await claim(30, 30, 100, 3)).map((p: { photo_id: number }) => p.photo_id))
  // No owner is an administrator here, yet each receives the general allowance of three.
  expect(ids.sort((a, b) => a - b)).toEqual([1, 2, 3, 11, 12, 13, 21, 22, 23])
})
it('the withdrawn member allowance leaves no function behind', async () => {
  await db.exec('RESET ROLE')
  expect(
    (
      await db.query(
        "SELECT p.oid::regprocedure::text AS f FROM pg_proc p WHERE p.proname IN ('claim_photo_ai','photo_ai_unlimited_owners') ORDER BY 1",
      )
    ).rows,
  ).toEqual([{ f: 'claim_photo_ai(uuid,integer,integer,integer,integer)' }])
  expect(
    (
      await db.query(
        "SELECT l.lanname,has_function_privilege('personal_photos_maintenance',p.oid,'EXECUTE') AS maintenance,has_function_privilege('personal_photos_app',p.oid,'EXECUTE') AS app FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.proname='claim_photo_ai'",
      )
    ).rows,
  ).toEqual([{ lanname: 'plpgsql', maintenance: true, app: false }])
})
it('enforces fleet and tenant concurrency across independent callers', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => claim()))
  expect(results.flat().map((p) => p.photo_id)).toEqual([1, 11, 21])
  expect(
    (await db.query('SELECT count(*)::int n FROM photos WHERE ai_claim IS NOT NULL')).rows,
  ).toEqual([{ n: 3 }])
})
it('rotates eligible tenants rather than draining the first owners library', async () => {
  const ids = []
  for (let i = 0; i < 6; i++) {
    const [p] = await claim(1, 1)
    ids.push(p.photo_id)
    await db.query(
      "UPDATE photos SET ai_description='done',ai_claim=NULL,ai_lease_until=NULL WHERE photo_id=$1",
      [p.photo_id],
    )
  }
  expect(ids).toEqual([1, 11, 21, 2, 12, 22])
})
it('allows eight requests for a lone owner and admits a new owner in the next free slot', async () => {
  await db.exec('RESET ROLE; UPDATE photos SET event_id=1; SET ROLE personal_photos_maintenance')
  const active = (await Promise.all(Array.from({ length: 8 }, () => claim(8, 8)))).flat()
  expect(active).toHaveLength(8)
  expect(await claim(8, 8)).toEqual([])
  await db.exec(
    "RESET ROLE; INSERT INTO photos(photo_id,event_id,display_stage_path,file_hash) VALUES(1000,2,'display/new','new'); SET ROLE personal_photos_maintenance",
  )
  await db.query(
    "UPDATE photos SET ai_description='done',ai_claim=NULL,ai_lease_until=NULL WHERE photo_id=$1",
    [active[0].photo_id],
  )
  expect((await claim(8, 8))[0].photo_id).toBe(1000)
})
it('enforces conservative hourly budgets including abandoned attempts', async () => {
  expect((await claim(3, 3, 2, 1))[0].photo_id).toBe(1)
  expect((await claim(3, 3, 2, 1))[0].photo_id).toBe(11)
  expect(await claim(3, 3, 2, 1)).toEqual([])
  await db.exec(
    "UPDATE photos SET ai_lease_until=now()-interval '1 second'; UPDATE photo_ai_admission SET window_start=now()-interval '2 hours'; UPDATE photo_ai_tenant_admission SET window_start=now()-interval '2 hours'",
  )
  expect((await claim(3, 3, 2, 1))[0].photo_id).toBe(21)
})
it('reclaims an expired lease but not a live one; a stale token cannot publish', async () => {
  const first = await claim(1, 1)
  const old = (await db.query<{ ai_claim: string }>('SELECT ai_claim FROM photos WHERE photo_id=1'))
    .rows[0].ai_claim
  expect(await claim(1, 1)).toEqual([])
  await db.exec(
    "UPDATE photos SET ai_lease_until=now()-interval '1 second'; UPDATE photos SET ingest_status='PENDING' WHERE event_id<>1",
  )
  expect((await claim(1, 1))[0].photo_id).toBe(first[0].photo_id)
  expect(
    (
      await db.query(
        'UPDATE photos SET ai_description=$1 WHERE photo_id=1 AND ai_claim=$2 RETURNING photo_id',
        ['stale', old],
      )
    ).rows,
  ).toEqual([])
  expect((await db.query('SELECT ai_attempts FROM photos WHERE photo_id=1')).rows).toEqual([
    { ai_attempts: 2 },
  ])
})
it('excludes poisoned, delayed, non-ready and video inputs', async () => {
  await db.exec(
    "UPDATE photos SET ai_attempts=3 WHERE photo_id=1; UPDATE photos SET ai_next_attempt_at=now()+interval '1 hour' WHERE photo_id=2; UPDATE photos SET ingest_status='PENDING' WHERE photo_id=3; UPDATE photos SET media_type='video' WHERE photo_id=4",
  )
  expect((await claim())[0].photo_id).toBe(5)
})
it('denies application callers and rejects invalid limits without claiming', async () => {
  await expect(claim(0)).rejects.toThrow('Invalid photo AI admission')
  await db.exec('RESET ROLE; SET ROLE personal_photos_app')
  await expect(claim()).rejects.toThrow('permission denied')
  await expect(db.query('SELECT * FROM photo_ai_admission')).rejects.toThrow('permission denied')
})
it('requires explicit spend-control budgets and REST before enabling independent schedulers', () => {
  expect(photoAiAdmission()).toBeNull()
  vi.stubEnv('PHOTO_AI_LEASED_ADMISSION', 'true')
  expect(() => photoAiAdmission()).toThrow('PHOTO_AI_MAX_CLAIMS_PER_HOUR')
  vi.stubEnv('PHOTO_AI_MAX_CLAIMS_PER_HOUR', '100')
  vi.stubEnv('PHOTO_AI_TENANT_MAX_CLAIMS_PER_HOUR', '50')
  expect(() => photoAiAdmission()).toThrow('direct REST')
  vi.stubEnv('PHOTO_AI_TRANSPORT', 'rest')
  expect(photoAiAdmission()).toEqual({
    fleet: 3,
    tenant: 1,
    hourly: 100,
    tenantHourly: 50,
    workers: 3,
  })
  vi.stubEnv('PHOTO_AI_TENANT_CONCURRENCY', '4')
  expect(() => photoAiAdmission()).toThrow('PHOTO_AI_TENANT_CONCURRENCY')
})

it('parses provider delays with a bounded fallback', async () => {
  const { photoAiRetryAfter } = await import('@/lib/photos/photo-ai-retry')
  const now = Date.parse('2026-10-29T12:00:00Z')
  expect(photoAiRetryAfter('900', now)).toBe(900)
  expect(photoAiRetryAfter('Thu, 29 Oct 2026 12:30:00 GMT', now)).toBe(1800)
  expect(photoAiRetryAfter('invalid', now)).toBe(300)
  expect(photoAiRetryAfter('999999', now)).toBe(86400)
})
