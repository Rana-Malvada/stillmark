import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'

let db: PGlite
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`CREATE ROLE personal_photos_app; CREATE SCHEMA photo_security;
 CREATE TABLE album_public_links(event_id int,owner_username text,token_hash text,revoked_at timestamptz,expires_at timestamptz);
 CREATE TABLE events(event_id int,owner_username text);
 CREATE TABLE photos(photo_id int,event_id int);
 CREATE TABLE faces(face_id int,photo_id int,owner_username text,ignored boolean,box_x real,box_y real,box_w real,box_h real);
 CREATE TABLE face_assignments(face_id int,owner_username text,person_id int,status text);
 CREATE TABLE face_people(person_id int,owner_username text,name text,hidden boolean);
 INSERT INTO events VALUES(1,'ALICE'),(2,'BOB');
 INSERT INTO photos VALUES(1,1),(2,2);
 INSERT INTO album_public_links VALUES(1,'ALICE','allowed',NULL,now()+interval '1 day'),(1,'ALICE','disabled',NULL,now()+interval '1 day'),(1,'ALICE','expired',NULL,now()-interval '1 day'),(1,'ALICE','revoked',now(),now()+interval '1 day'),(1,'OLD','transferred',NULL,now()+interval '1 day');
 INSERT INTO faces SELECT i,CASE WHEN i=7 THEN 2 ELSE 1 END,CASE WHEN i=7 THEN 'BOB' WHEN i=6 THEN 'OLD' ELSE 'ALICE' END,i=3,NULL,NULL,NULL,NULL FROM generate_series(1,7)i;
 INSERT INTO face_people SELECT i,CASE WHEN i=7 THEN 'BOB' WHEN i=6 THEN 'OLD' ELSE 'ALICE' END,CASE WHEN i=5 THEN NULL ELSE 'Person '||i END,i=4 FROM generate_series(1,7)i;
 INSERT INTO face_assignments SELECT face_id,owner_username,face_id,CASE WHEN face_id=2 THEN 'suggested' ELSE 'confirmed' END FROM faces;`)
  await db.exec(readFileSync('migrations/postgres/202610202000_public_album_details.sql', 'utf8'))
  await db.exec(
    `UPDATE album_public_links SET include_people=true WHERE token_hash<>'disabled';GRANT USAGE ON SCHEMA photo_security TO personal_photos_app;`,
  )
}, 30000)
afterAll(async () => db?.close())
async function names(hash: string, photo = 1) {
  await db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
  try {
    await db.query("SELECT set_config('photos.public_hash',$1,true)", [hash])
    return (await db.query('SELECT * FROM photo_security.public_photo_people($1)', [photo])).rows
  } finally {
    await db.exec('ROLLBACK')
  }
}
it('only returns settled visible names belonging to the album current owner', async () => {
  expect(await names('allowed')).toEqual([{ name: 'Person 1', box: null }])
})
it('denies disabled, expired, revoked, transferred and missing capabilities', async () => {
  for (const hash of ['disabled', 'expired', 'revoked', 'transferred', 'missing', ''])
    expect(await names(hash)).toEqual([])
})
it('denies another album and missing photos', async () => {
  expect(await names('allowed', 2)).toEqual([])
  expect(await names('allowed', 99)).toEqual([])
})
it('keeps existing link location off and does not grant raw face-table access', async () => {
  expect(
    (await db.query('SELECT include_location FROM album_public_links')).rows.every(
      (r: any) => r.include_location === false,
    ),
  ).toBe(true)
  await db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
  try {
    await expect(db.query('SELECT * FROM faces')).rejects.toThrow()
  } finally {
    await db.exec('ROLLBACK')
  }
})
