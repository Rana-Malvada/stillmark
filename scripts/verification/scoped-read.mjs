import assert from 'node:assert/strict'
import { withLocalPostgres } from './local-postgres.mjs'
import { scopedReadStatement } from '../../lib/postgres-scoped-read.mjs'

await withLocalPostgres('scoped-read', async ({ admin, connect }) => {
  await admin.query(
    `CREATE ROLE personal_photos_reader NOLOGIN NOBYPASSRLS;CREATE TABLE photos(id int,owner text);INSERT INTO photos VALUES(1,'alice'),(2,'bob');ALTER TABLE photos ENABLE ROW LEVEL SECURITY;ALTER TABLE photos FORCE ROW LEVEL SECURITY;GRANT SELECT ON photos TO personal_photos_reader;CREATE POLICY read_own ON photos TO personal_photos_reader USING(owner=current_setting('photos.username',true));`,
  )
  const client = await connect()
  const read = (who) =>
    client.query(
      scopedReadStatement(
        'SELECT id FROM photos WHERE id>$1',
        [0],
        { username: who, mainAdmin: false },
        true,
      ),
    )
  for (const [who, expected] of [
    ['alice', [{ id: 1 }]],
    ['bob', [{ id: 2 }]],
    ["alice';RESET ROLE;--", []],
  ]) {
    const results = await read(who)
    assert.equal(results.at(-1).command, 'COMMIT')
    assert.deepEqual(results.at(-2).rows, expected)
    assert.equal(
      (
        await client.query(
          "SELECT current_setting('photos.username',true) AS identity,current_user",
        )
      ).rows[0].identity,
      '',
    )
  }
  await assert.rejects(
    client.query(
      scopedReadStatement(
        'WITH removed AS (DELETE FROM photos RETURNING *) SELECT * FROM removed',
        [],
        { username: 'alice', mainAdmin: false },
      ),
    ),
  )
  await client.query('ROLLBACK')
  assert.equal((await read('alice')).at(-2).rows.length, 1)
  console.log(
    'PASS actual PostgreSQL simple-protocol batch: one exchange; RLS isolation; escaped identity; transaction-local cleanup; writes denied; rollback recovery',
  )
})
