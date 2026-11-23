import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ db: null as any, inTransaction: false, stage: vi.fn() }))
vi.mock('@/lib/postgres', () => ({
  pgQuery: async (sql: string, args: unknown[]) => (await m.db.query(sql, args)).rows,
  pgQueryOne: async (sql: string, args: unknown[]) => (await m.db.query(sql, args)).rows[0],
  pgTransaction: async (fn: () => unknown) => {
    await m.db.exec('BEGIN')
    m.inTransaction = true
    try {
      const result = await fn()
      await m.db.exec('COMMIT')
      return result
    } catch (error) {
      await m.db.exec('ROLLBACK')
      throw error
    } finally {
      m.inTransaction = false
    }
  },
}))
vi.mock('@/lib/upload/upload-chunk-stage', () => ({ storeUploadChunk: m.stage }))
import { writeUploadChunk } from '@/lib/upload/upload-chunk-write'

const id = '00000000-0000-4000-8000-000000000001'
beforeEach(async () => {
  m.db = new PGlite()
  m.stage.mockReset()
  await m.db.exec(`CREATE ROLE personal_photos_app; CREATE ROLE personal_photos_maintenance;
    CREATE SCHEMA photo_security;
    CREATE FUNCTION photo_security.username() RETURNS text LANGUAGE sql AS $$SELECT current_setting('photos.username',true)$$;
    CREATE FUNCTION photo_security.flag(text) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
    GRANT USAGE ON SCHEMA photo_security TO personal_photos_app;
    CREATE TABLE upload_sessions(upload_id uuid PRIMARY KEY, owner text,total_chunks int,bytes bigint DEFAULT 0,result jsonb,expires_at timestamptz DEFAULT now()+interval '1 hour',completion_lease_until timestamptz);
    CREATE TABLE upload_chunks(upload_id uuid REFERENCES upload_sessions ON DELETE CASCADE,chunk_index int,stage_path text,byte_size int,hash text,PRIMARY KEY(upload_id,chunk_index));
    CREATE TABLE upload_processing_jobs(upload_id uuid);
    INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES('${id}','ALICE',1);`)
  await m.db.exec(
    readFileSync('migrations/postgres/202610290200_upload_chunk_reservations.sql', 'utf8'),
  )
  m.stage.mockImplementation(async () => {
    expect(m.inTransaction).toBe(false)
    return 'upload-chunks/attempt'
  })
})
afterEach(async () => {
  await m.db.close()
})
const write = () => writeUploadChunk(id, 'ALICE', 1, 0, 'hash', Buffer.from('abc'))
it('writes outside transactions and counts a replayed chunk only once', async () => {
  await write()
  await write()
  expect(m.stage).toHaveBeenCalledTimes(1)
  expect((await m.db.query('SELECT bytes FROM upload_sessions')).rows[0].bytes).toBe(3)
  expect((await m.db.query('SELECT * FROM upload_chunk_writes')).rows).toHaveLength(0)
  await expect(
    writeUploadChunk(id, 'ALICE', 1, 0, 'different', Buffer.from('xyz')),
  ).rejects.toMatchObject({ status: 409 })
})
it('cannot publish after cancellation even if the same upload ID is recreated', async () => {
  m.stage.mockImplementation(async () => {
    expect(m.inTransaction).toBe(false)
    await m.db.exec(
      `DELETE FROM upload_sessions; INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES('${id}','ALICE',1)`,
    )
    return 'upload-chunks/orphan'
  })
  await expect(write()).rejects.toMatchObject({ status: 409 })
  expect((await m.db.query('SELECT * FROM upload_chunks')).rows).toHaveLength(0)
})
it('fences an expired writer and preserves a replacement reservation', async () => {
  m.stage.mockImplementation(async () => {
    await m.db.exec("UPDATE upload_chunk_writes SET token='00000000-0000-4000-8000-000000000099'")
    return 'upload-chunks/stale'
  })
  await expect(write()).rejects.toMatchObject({ status: 409 })
  expect((await m.db.query('SELECT * FROM upload_chunk_writes')).rows).toHaveLength(1)
  expect((await m.db.query('SELECT * FROM upload_chunks')).rows).toHaveLength(0)
})
it('rejects another owner before storage and recovers after storage failure', async () => {
  await expect(writeUploadChunk(id, 'BOB', 1, 0, 'hash', Buffer.from('abc'))).rejects.toMatchObject(
    { status: 403 },
  )
  expect(m.stage).not.toHaveBeenCalled()
  m.stage.mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(write()).rejects.toThrow('storage unavailable')
  await write()
  expect((await m.db.query('SELECT * FROM upload_chunks')).rows).toHaveLength(1)
})
it('RLS prevents reading or replacing another owners reservation', async () => {
  await m.db
    .exec(`INSERT INTO upload_chunk_writes VALUES('${id}',0,'ALICE','${id}','hash',3,now()+interval '1 minute');
    SET ROLE personal_photos_app; SET photos.username='BOB'`)
  expect((await m.db.query('SELECT * FROM upload_chunk_writes')).rows).toHaveLength(0)
  await expect(
    m.db.query(`INSERT INTO upload_chunk_writes VALUES('${id}',1,'ALICE','${id}','hash',3,now())`),
  ).rejects.toThrow(/row-level security/)
})
