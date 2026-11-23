import { createTestDatabase } from './fixtures/test-database'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DANA = '22222222-2222-4222-8222-222222222222'
const BOBS = '33333333-3333-4333-8333-333333333333'
let db: PGlite

beforeAll(async () => {
  db = await createTestDatabase({
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
        sql: `SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app;
 GRANT SELECT,INSERT,UPDATE,DELETE ON events,photos,photo_trash,album_shares,album_public_links,stage_cleanup TO personal_photos_app;
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES(1,1,'Alice','a','ALICE','PRIVATE'),(2,2,'Bob','b','BOB','PRIVATE');
 INSERT INTO album_shares(event_id,username,created_by) VALUES(1,'CAROL','ALICE');
 INSERT INTO album_public_links(id,event_id,token_hash,owner_username,created_by,expires_at) VALUES('11111111-1111-4111-8111-111111111111',1,repeat('a',64),'ALICE','ALICE',now()+interval '1 hour');`,
      },
      'setup/72-app-rls.sql',
      '202610072000_people_faces',
      '202611142300_people_counts',
      '202611212300_people_counts_query_plans',
      {
        sql: `INSERT INTO face_settings(owner_username,enabled) VALUES('ALICE',true);
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path) VALUES
  (1,1,'a.jpg','photo','READY','originals/a.jpg'),(2,2,'b.jpg','photo','READY','originals/b.jpg'),(3,1,'v.mov','video','READY','originals/v.mov');
 INSERT INTO face_people(person_id,owner_username,name) VALUES('${DANA}','ALICE','Dana'),('${BOBS}','BOB','Secret');
 INSERT INTO faces(photo_id,owner_username,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding,crop_path)
  VALUES(1,'ALICE','originals/a.jpg','m1',0,0.1,0.1,0.2,0.2,0.99,0.9,true,'[1,0,0]','faces/1.webp'),
        (1,'ALICE','originals/a.jpg','m1',1,0.5,0.1,0.2,0.2,0.98,0.8,true,'[0,1,0]','faces/2.webp'),
        (2,'BOB','originals/b.jpg','m1',0,0.1,0.1,0.2,0.2,0.97,0.9,true,'[0,0,1]','faces/3.webp');
 INSERT INTO face_assignments(face_id,person_id,owner_username,status,score) VALUES(1,'${DANA}','ALICE','confirmed',1),(2,'${DANA}','ALICE','suggested',0.6),(3,'${BOBS}','BOB','auto',0.9);`,
      },
    ],
  })
}, 60000)
afterAll(async () => db?.close())

async function as(
  who: string,
  fn: () => Promise<void>,
  options: { flags?: Record<string, string>; role?: string } = {},
) {
  await db.exec(`BEGIN;SET LOCAL ROLE ${options.role ?? 'personal_photos_app'}`)
  try {
    for (const [k, v] of Object.entries({ username: who, can_write: 'true', ...options.flags }))
      await db.query('SELECT set_config($1,$2,true)', ['photos.' + k, v])
    await fn()
  } finally {
    await db.exec('ROLLBACK')
  }
}
const rows = async (sql: string) => (await db.query(sql)).rows
// An error aborts the surrounding transaction; isolate each expected failure.
async function fails(sql: string, error: RegExp) {
  await db.exec('SAVEPOINT expected_failure')
  await expect(db.query(sql)).rejects.toThrow(error)
  await db.exec('ROLLBACK TO SAVEPOINT expected_failure')
}
const FACE_COLUMNS = 'face_id,photo_id,owner_username,crop_path'
const PEOPLE_TABLES = [
  'face_settings',
  'face_people',
  'face_rejections',
  'face_corrections',
  'face_scan_runs',
  'face_scan_queue',
  'face_assignments',
]

describe('owner aggregate count boundary', () => {
  it('never accepts another owner scope, even for an administrator or shared viewer', async () => {
    for (const who of ['', 'CAROL']) {
      await as(
        who,
        async () => {
          expect(await rows('SELECT * FROM photo_security.person_counts(NULL)')).toEqual([])
          expect(await rows('SELECT * FROM photo_security.people_totals()')).toEqual([
            { unnamed: 0, people: 0, review: 0, unknown: 0, lowerConfidence: 0, ignored: 0 },
          ])
        },
        { flags: { main_admin: 'true' } },
      )
    }
    await as('ALICE', async () => {
      expect(await rows(`SELECT * FROM photo_security.person_counts('${BOBS}')`)).toEqual([])
      expect(await rows(`SELECT * FROM photo_security.person_counts('${DANA}')`)).toEqual([
        { person_id: DANA, photo_count: 1, review_count: 1, sort_count: 1 },
      ])
    })
  })
  it('does not count stale faces when an album changes owners', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(
        "UPDATE events SET owner_username='BOB' WHERE event_id=1;SET LOCAL ROLE personal_photos_app;SELECT set_config('photos.username','ALICE',true)",
      )
      expect(await rows('SELECT * FROM photo_security.person_counts(NULL)')).toEqual([])
      expect(await rows('SELECT * FROM photo_security.people_totals()')).toEqual([
        { unnamed: 0, people: 0, review: 0, unknown: 0, lowerConfidence: 0, ignored: 0 },
      ])
    } finally {
      await db.exec('ROLLBACK')
    }
  })
})

describe('people row security', () => {
  it('fails closed without an identity', async () => {
    await as('', async () => {
      for (const t of PEOPLE_TABLES) expect(await rows(`SELECT * FROM ${t}`), t).toEqual([])
      expect(await rows(`SELECT ${FACE_COLUMNS} FROM faces`)).toEqual([])
    })
  })
  it('separates owners completely', async () => {
    await as('ALICE', async () => {
      expect(await rows('SELECT name FROM face_people')).toEqual([{ name: 'Dana' }])
      expect(await rows('SELECT face_id FROM faces ORDER BY 1')).toEqual([
        { face_id: 1 },
        { face_id: 2 },
      ])
      expect(
        await rows(`UPDATE face_people SET name='x' WHERE person_id='${BOBS}' RETURNING 1`),
      ).toEqual([])
      await fails(
        `INSERT INTO face_people(owner_username,name) VALUES('BOB','Planted')`,
        /row-level security/,
      )
    })
  })
  it('never exposes embeddings to the web application', async () => {
    await as('ALICE', async () => {
      await fails('SELECT embedding FROM faces', /permission denied/)
    })
  })
  it('hides names from shared viewers until the owner shares them, then only settled matches', async () => {
    await as('CAROL', async () => {
      expect(await rows('SELECT name FROM face_people')).toEqual([])
      expect(await rows('SELECT face_id FROM faces')).toEqual([])
    })
    await db.exec(`UPDATE face_settings SET share_names=true WHERE owner_username='ALICE'`)
    await as('CAROL', async () => {
      expect(await rows('SELECT name FROM face_people')).toEqual([{ name: 'Dana' }])
      // The suggested (unconfirmed) face 2 is not revealed.
      expect(await rows('SELECT face_id FROM faces')).toEqual([{ face_id: 1 }])
      expect(await rows(`UPDATE face_people SET name='x' RETURNING 1`)).toEqual([])
      expect(await rows('SELECT * FROM face_rejections')).toEqual([])
      expect(await rows('SELECT * FROM face_corrections')).toEqual([])
    })
    await db.exec(`UPDATE face_settings SET share_names=false WHERE owner_username='ALICE'`)
  })
  it('gives public links no people data even when names are shared', async () => {
    await db.exec(`UPDATE face_settings SET share_names=true WHERE owner_username='ALICE'`)
    await as('', async () => {
      await db.query("SELECT set_config('photos.public_hash',$1,true)", ['a'.repeat(64)])
      expect(await rows('SELECT photo_id FROM photos WHERE photo_id=1')).toHaveLength(1)
      expect(await rows('SELECT * FROM face_people')).toEqual([])
      expect(await rows(`SELECT ${FACE_COLUMNS} FROM faces`)).toEqual([])
      expect(await rows('SELECT * FROM face_assignments')).toEqual([])
    })
    await db.exec(`UPDATE face_settings SET share_names=false WHERE owner_username='ALICE'`)
  })
  it('keeps read-only identities from editing people', async () => {
    await as(
      'ALICE',
      async () => {
        expect(await rows('SELECT name FROM face_people')).toHaveLength(1)
        expect(await rows(`UPDATE face_people SET name='x' RETURNING 1`)).toEqual([])
      },
      { flags: { can_write: 'false' } },
    )
  })
  it('limits scan operations to main administrators', async () => {
    const start = `INSERT INTO face_scan_runs(id,requested_by,kind,status,photo_limit) VALUES(gen_random_uuid(),'ALICE','pilot','starting',10)`
    await as('ALICE', () => fails(start, /row-level security/))
    await as(
      'ALICE',
      async () => {
        await db.query(start)
        await fails(start, /face_scan_runs_one_active/)
      },
      { flags: { main_admin: 'true' } },
    )
  })
})

describe('corrections take priority over scans', () => {
  it('prevents the worker from changing or removing confirmed assignments', async () => {
    await as(
      '',
      async () => {
        await fails(`UPDATE face_assignments SET status='auto' WHERE face_id=1`, /user-owned/)
        await fails('DELETE FROM face_assignments WHERE face_id=1', /user-owned/)
        await fails('DELETE FROM faces WHERE face_id=1', /user-owned/)
        expect(
          await rows(`UPDATE face_assignments SET status='auto' WHERE face_id=2 RETURNING status`),
        ).toEqual([{ status: 'auto' }])
      },
      { role: 'personal_photos_face_worker' },
    )
  })
  it('never reassigns a face to a person it was rejected for', async () => {
    await as('ALICE', async () => {
      await db.query(`DELETE FROM face_assignments WHERE face_id=2`)
      await db.query(
        `INSERT INTO face_rejections(face_id,person_id,owner_username) VALUES(2,'${DANA}','ALICE')`,
      )
      await fails(
        `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES(2,'${DANA}','ALICE','confirmed')`,
        /rejected/,
      )
    })
  })
  it('makes cross-owner assignments impossible', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(`DELETE FROM face_assignments WHERE face_id=3`)
      await fails(
        `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES(3,'${DANA}','ALICE','auto')`,
        /foreign key/,
      )
      await fails(
        `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES(3,'${DANA}','BOB','auto')`,
        /foreign key/,
      )
    } finally {
      await db.exec('ROLLBACK')
    }
  })
})

describe('manual tags for faces the scanner missed', () => {
  const tag = (owner: string, photo: number, by: string, box = '0.2,0.2,0.1,0.1') =>
    `INSERT INTO faces(photo_id,owner_username,source,box_x,box_y,box_w,box_h,created_by)
     VALUES(${photo},'${owner}','manual',${box},'${by}') RETURNING face_id`
  it('lets the owner tag a person with a box or with no box, and assign them', async () => {
    await as('ALICE', async () => {
      const [{ face_id }] = (await db.query<{ face_id: number }>(tag('ALICE', 1, 'ALICE'))).rows
      await db.query(
        `INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES($1,'${DANA}','ALICE','confirmed')`,
        [face_id],
      )
      const nameOnly = tag('ALICE', 1, 'ALICE', 'NULL,NULL,NULL,NULL')
      expect((await db.query(nameOnly)).rows).toHaveLength(1)
      expect(
        await rows(`UPDATE faces SET box_x=0.3 WHERE face_id=${face_id} RETURNING box_x`),
      ).toHaveLength(1)
    })
  })
  it('rejects partial or out-of-image boxes', async () => {
    await as('ALICE', async () => {
      await fails(tag('ALICE', 1, 'ALICE', '0.2,NULL,0.1,0.1'), /check constraint/)
      await fails(tag('ALICE', 1, 'ALICE', '0.95,0.2,0.1,0.1'), /check constraint/)
    })
  })
  it('blocks tags by viewers, on other owners’ photos, or impersonating another tagger', async () => {
    await as('CAROL', () => fails(tag('ALICE', 1, 'CAROL'), /row-level security/))
    await as('ALICE', async () => {
      await fails(tag('ALICE', 2, 'ALICE'), /row-level security/)
      await fails(tag('BOB', 2, 'ALICE'), /row-level security/)
      await fails(tag('ALICE', 1, 'BOB'), /row-level security/)
    })
    await as('ALICE', () => fails(tag('ALICE', 1, 'ALICE'), /row-level security/), {
      flags: { can_write: 'false' },
    })
  })
  it('never lets the app forge a detected face or an embedding', async () => {
    await as('ALICE', async () => {
      await fails(
        `INSERT INTO faces(photo_id,owner_username,source,box_x,box_y,box_w,box_h,created_by) VALUES(1,'ALICE','detected',0.1,0.1,0.1,0.1,'ALICE')`,
        /row-level security|check constraint/,
      )
      await fails(
        `INSERT INTO faces(photo_id,owner_username,source,created_by,embedding) VALUES(1,'ALICE','manual','ALICE','[1,0,0]')`,
        /permission denied/,
      )
      await fails(`UPDATE faces SET box_x=0.4 WHERE face_id=1`, /scanner-owned/)
    })
  })
  it('protects manual tags from the worker', async () => {
    await db.exec(
      `INSERT INTO faces(photo_id,owner_username,source,created_by) VALUES(1,'ALICE','manual','ALICE')`,
    )
    await as('', () => fails(`DELETE FROM faces WHERE source='manual'`, /user-owned/), {
      role: 'personal_photos_face_worker',
    })
  })
})

describe('worker boundary', () => {
  it('can read catalog paths but not captions or other metadata', async () => {
    await as(
      '',
      async () => {
        expect(
          await rows('SELECT photo_id,original_stage_path FROM photos ORDER BY 1'),
        ).toHaveLength(3)
        await fails('SELECT caption FROM photos', /permission denied/)
        await fails(`UPDATE photos SET caption='x'`, /permission denied/)
        await fails('SELECT * FROM face_corrections', /permission denied/)
      },
      { role: 'personal_photos_face_worker' },
    )
  })
})

describe('lifecycle', () => {
  it('queues opted-in still photos only', async () => {
    expect(
      await rows('SELECT photo_id,owner_username,source_path FROM face_scan_queue ORDER BY 1'),
    ).toEqual([{ photo_id: 1, owner_username: 'ALICE', source_path: 'originals/a.jpg' }])
  })
  it('requeues when the original changes and not otherwise', async () => {
    await db.exec(`UPDATE face_scan_queue SET status='done' WHERE photo_id=1`)
    await db.exec(`UPDATE photos SET ingest_status='READY' WHERE photo_id=1`)
    expect(await rows('SELECT status FROM face_scan_queue WHERE photo_id=1')).toEqual([
      { status: 'done' },
    ])
    await db.exec(`UPDATE photos SET original_stage_path='originals/a2.jpg' WHERE photo_id=1`)
    expect(await rows('SELECT status,source_path FROM face_scan_queue WHERE photo_id=1')).toEqual([
      { status: 'queued', source_path: 'originals/a2.jpg' },
    ])
    await db.exec(`UPDATE photos SET original_stage_path='originals/a.jpg' WHERE photo_id=1`)
  })
  it('keeps face data while a photo is in Trash and removes it on permanent deletion', async () => {
    const count = async () =>
      (await db.query<{ n: number }>('SELECT count(*)::int n FROM faces WHERE photo_id=1')).rows[0]
        .n
    const before = await count()
    expect(before).toBeGreaterThan(0)
    await db.exec(`INSERT INTO photo_trash(photo_id,photo_data,album_name,owner_username)
      SELECT photo_id,to_jsonb(p),'Alice','ALICE' FROM photos p WHERE photo_id=1;
      DELETE FROM photos WHERE photo_id=1;`)
    expect(await count()).toBe(before)
    await db.exec(`INSERT INTO photos SELECT * FROM jsonb_populate_record(NULL::photos,(SELECT photo_data FROM photo_trash WHERE photo_id=1));
      DELETE FROM photo_trash WHERE photo_id=1;`)
    expect(await count()).toBe(before)
    await db.exec(`INSERT INTO photo_trash(photo_id,photo_data,album_name,owner_username)
      SELECT photo_id,to_jsonb(p),'Alice','ALICE' FROM photos p WHERE photo_id=1;
      DELETE FROM photos WHERE photo_id=1; DELETE FROM photo_trash WHERE photo_id=1;`)
    expect(await count()).toBe(0)
    expect(await rows('SELECT count(*)::int n FROM face_scan_queue WHERE photo_id=1')).toEqual([
      { n: 0 },
    ])
    expect(
      await rows(`SELECT path FROM stage_cleanup WHERE path LIKE 'faces/%' ORDER BY 1`),
    ).toEqual([{ path: 'faces/1.webp' }, { path: 'faces/2.webp' }])
  })
})
