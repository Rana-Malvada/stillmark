import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { claimUploadJobSql, retryUploadJob } from '@/lib/upload/upload-processing-policy'
import { HttpError } from '@/lib/http'

it('queue isolates owners, claims once, recovers leases, and fences stale publishers', async () => {
  const db = new PGlite()
  const a = '00000000-0000-4000-8000-000000000001'
  const b = '00000000-0000-4000-8000-000000000002'
  const t1 = '00000000-0000-4000-8000-000000000011'
  const t2 = '00000000-0000-4000-8000-000000000012'
  try {
    await db.exec(`CREATE ROLE personal_photos_app;CREATE ROLE personal_photos_maintenance;
   CREATE SCHEMA photo_security;
   CREATE FUNCTION photo_security.username() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('photos.username',true),'')$$;
   CREATE FUNCTION photo_security.flag(n text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('photos.'||n,true),'false')='true'$$;
   GRANT USAGE ON SCHEMA photo_security,public TO personal_photos_app,personal_photos_maintenance;
   CREATE TABLE upload_sessions(upload_id uuid PRIMARY KEY,owner text,result jsonb);
   INSERT INTO upload_sessions VALUES('${a}','ALICE',null),('${b}','BOB',null);`)
    await db.exec(readFileSync('migrations/postgres/202610242230_upload_routing.sql', 'utf8'))
    await db.exec(
      readFileSync('migrations/postgres/202610242350_upload_processing_queue.sql', 'utf8'),
    )
    await db.exec(
      `SET ROLE personal_photos_app;SELECT set_config('photos.username','ALICE',false),set_config('photos.can_write','true',false)`,
    )
    await db.query(
      `INSERT INTO upload_processing_jobs(upload_id,owner,body,caller,auth_epoch) VALUES($1,'ALICE','{}','{}','1')`,
      [a],
    )
    await expect(
      db.query(
        `INSERT INTO upload_processing_jobs(upload_id,owner,body,caller,auth_epoch) VALUES($1,'BOB','{}','{}','1')`,
        [b],
      ),
    ).rejects.toThrow(/row-level security/)
    await db.exec(`SELECT set_config('photos.username','BOB',false)`)
    expect((await db.query('SELECT * FROM upload_processing_jobs')).rows).toHaveLength(0)
    await db.exec('RESET ROLE;SET ROLE personal_photos_upload_queue')
    await expect(db.exec("UPDATE upload_routing SET route='app'")).rejects.toThrow(
      /permission denied/,
    )
    await expect(db.exec('SELECT * FROM upload_sessions')).rejects.toThrow(/permission denied/)
    const first = await db.query(claimUploadJobSql, [t1, 'pool'])
    expect(first.rows).toHaveLength(1)
    expect((await db.query(claimUploadJobSql, [t2, 'pool'])).rows).toHaveLength(0)
    await db.exec("UPDATE upload_processing_jobs SET lease_until=now()-interval '1 second'")
    const second = await db.query<{ lease_token: string; attempts: number }>(claimUploadJobSql, [
      t2,
      'app',
    ])
    expect(second.rows[0]).toMatchObject({ lease_token: t2, attempts: 2 })
    expect(
      (
        await db.query(
          "UPDATE upload_processing_jobs SET state='done' WHERE upload_id=$1 AND lease_token=$2 RETURNING upload_id",
          [a, t1],
        )
      ).rows,
    ).toHaveLength(0)
    expect(
      (
        await db.query(
          "UPDATE upload_processing_jobs SET state='done' WHERE upload_id=$1 AND lease_token=$2 RETURNING upload_id",
          [a, t2],
        )
      ).rows,
    ).toHaveLength(1)
    expect((await db.query(claimUploadJobSql, [t1, 'pool'])).rows).toHaveLength(0)
    await db.exec('RESET ROLE')
    await db.query('DELETE FROM upload_sessions WHERE upload_id=$1', [a])
    expect((await db.query('SELECT * FROM upload_processing_jobs')).rows).toHaveLength(0)
  } finally {
    await db.close()
  }
}, 30000)
it('retries transient failures but stops permanent failures and bounds attempts', () => {
  expect(retryUploadJob(new Error('connection reset'), 1)).toBe(true)
  expect(retryUploadJob(new HttpError(429, 'busy'), 2)).toBe(true)
  for (const status of [400, 403, 404, 413, 415, 422])
    expect(retryUploadJob(new HttpError(status, 'bad'), 1)).toBe(false)
  expect(retryUploadJob(new Error('offline'), 5)).toBe(false)
})
