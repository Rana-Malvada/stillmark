import { createTestDatabase } from './fixtures/test-database'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'

let db: PGlite
beforeAll(async () => {
  db = await createTestDatabase({
    roles: [
      'snowflake_admin',
      'personal_photos_app NOINHERIT',
      'personal_photos_reader',
      'personal_photos_video_worker',
    ],
    steps: [
      {
        sql: `SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO personal_photos_app;GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO personal_photos_app;
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES(1,1,'Alice','a','ALICE','PRIVATE'),(2,2,'Bob','b','BOB','PRIVATE'),(3,3,'Gallery','c','BOB','GALLERY'),(4,4,'Shared','d','BOB','PRIVATE');
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path) VALUES(1,1,'a.jpg','photo','READY','a'),(2,2,'b.jpg','photo','READY','b'),(3,3,'c.jpg','photo','READY','c'),(4,4,'d.jpg','photo','READY','d');
 INSERT INTO album_shares(event_id,username,created_by) VALUES(4,'ALICE','BOB');
 INSERT INTO album_public_links(id,event_id,token_hash,owner_username,created_by,expires_at) VALUES('11111111-1111-4111-8111-111111111111',2,repeat('a',64),'BOB','BOB',now()+interval '1 hour');`,
      },
      'setup/72-app-rls.sql',
      {
        transaction: [
          '202610251400_album_permission_queries',
          '202610251430_permission_list_indexes',
        ],
      },
      '202610270130_indexed_app_photo_policy',
    ],
  })
}, 30000)
afterAll(async () => db?.close())
async function asUser(who: string, fn: () => Promise<void>, flags: Record<string, string> = {}) {
  await db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
  try {
    for (const [k, v] of Object.entries({ username: who, can_write: 'true', ...flags }))
      await db.query('SELECT set_config($1,$2,true)', ['photos.' + k, v])
    await fn()
  } finally {
    await db.exec('ROLLBACK')
  }
}
it('fails closed without identity on every application table', async () => {
  await asUser('', async () => {
    const tables = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    )
    for (const { tablename } of tables.rows)
      expect((await db.query(`SELECT * FROM public.${tablename}`)).rows, tablename).toEqual([])
  })
})
it('separates users and blocks writes to readable shared/gallery albums', async () => {
  await asUser('ALICE', async () => {
    expect((await db.query('SELECT photo_id FROM photos ORDER BY photo_id')).rows).toEqual([
      { photo_id: 1 },
      { photo_id: 3 },
      { photo_id: 4 },
    ])
    expect(
      (await db.query("UPDATE photos SET caption='no' WHERE photo_id=2 RETURNING photo_id")).rows,
    ).toEqual([])
    expect(
      (await db.query("UPDATE photos SET caption='no' WHERE photo_id=3 RETURNING photo_id")).rows,
    ).toEqual([])
    expect(
      (await db.query("UPDATE photos SET caption='yes' WHERE photo_id=1 RETURNING photo_id")).rows,
    ).toEqual([{ photo_id: 1 }])
    await expect(
      db.query("INSERT INTO photos(event_id,source_filename) VALUES(2,'intruder')"),
    ).rejects.toThrow(/row-level security/)
  })
})
it('prevents moving owned photos into another owner’s album', async () => {
  await asUser('ALICE', async () => {
    await expect(db.query('UPDATE photos SET event_id=2 WHERE photo_id=1')).rejects.toThrow(
      /row-level security/,
    )
  })
})
it('keeps public access token-bound, read-only and immediately revocable', async () => {
  await asUser('', async () => {
    await db.query("SELECT set_config('photos.public_hash',$1,true)", ['a'.repeat(64)])
    expect((await db.query('SELECT photo_id FROM photos ORDER BY photo_id')).rows).toEqual([
      { photo_id: 2 },
    ])
    expect((await db.query("UPDATE photos SET caption='no' RETURNING photo_id")).rows).toEqual([])
  })
  await db.exec('UPDATE album_public_links SET revoked_at=now()')
  await asUser('', async () => {
    await db.query("SELECT set_config('photos.public_hash',$1,true)", ['a'.repeat(64)])
    expect((await db.query('SELECT * FROM photos')).rows).toEqual([])
  })
  await db.exec('UPDATE album_public_links SET revoked_at=NULL')
})
it('keeps ordinary admin privacy and read-only grants intact', async () => {
  await asUser(
    'ALICE',
    async () => expect((await db.query('SELECT * FROM photos')).rows).toHaveLength(3),
    { admin_read: 'true', admin_write: 'true' },
  )
  await asUser(
    'ALICE',
    async () =>
      expect((await db.query("UPDATE photos SET caption='no' RETURNING photo_id")).rows).toEqual(
        [],
      ),
    { can_write: 'false', admin_read: 'true' },
  )
  await asUser(
    'OWNER',
    async () => expect((await db.query('SELECT * FROM photos')).rows).toHaveLength(4),
    { main_admin: 'true' },
  )
})
it('does not let the application assume the maintenance role', async () => {
  const original = (await db.query<{ name: string }>('SELECT session_user AS name')).rows[0].name
  await db.exec('SET SESSION AUTHORIZATION personal_photos_app')
  try {
    await expect(db.exec('SET ROLE personal_photos_maintenance')).rejects.toThrow(
      /permission denied/,
    )
  } finally {
    await db.exec('SET SESSION AUTHORIZATION ' + JSON.stringify(original) + '; RESET ROLE')
  }
})
it('uses a separate maintenance role and keeps identity cleared on connection reuse', async () => {
  await db.exec('SET ROLE personal_photos_maintenance')
  expect((await db.query('SELECT * FROM photos')).rows).toHaveLength(4)
  await db.exec('RESET ROLE')
  await asUser('', async () => expect((await db.query('SELECT * FROM photos')).rows).toEqual([]))
})
it('allows authorized uploads, trigger queues, trash, and activity without cross-user access', async () => {
  await asUser('ALICE', async () => {
    await db.query(
      "INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path) VALUES(20,1,'video.mov','video','READY','video')",
    )
    expect(
      (await db.query('SELECT photo_id FROM video_playback WHERE photo_id=20')).rows,
    ).toHaveLength(1)
    await db.query(
      "INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES('22222222-2222-4222-8222-222222222222','ALICE',1)",
    )
    await db.query(
      "INSERT INTO user_activity_events(event_id,username,kind,source) VALUES('33333333-3333-4333-8333-333333333333','ALICE','app_visit','server')",
    )
    expect((await db.query('SELECT * FROM user_activity_daily')).rows).toHaveLength(1)
    await expect(
      db.query(
        "INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES('44444444-4444-4444-8444-444444444444','BOB',1)",
      ),
    ).rejects.toThrow(/row-level security/)
  })
})
it('denies expired and ownership-invalidated public capabilities', async () => {
  for (const change of [
    "UPDATE album_public_links SET expires_at=now()-interval '1 second'",
    "UPDATE album_public_links SET owner_username='ALICE'",
  ]) {
    await db.exec(change)
    await asUser('', async () => {
      await db.query("SELECT set_config('photos.public_hash',$1,true)", ['a'.repeat(64)])
      expect((await db.query('SELECT * FROM photos')).rows).toEqual([])
    })
    await db.exec(
      "UPDATE album_public_links SET expires_at=now()+interval '1 hour',owner_username='BOB'",
    )
  }
})
it('keeps upload sessions, folder preferences, and activity private across users', async () => {
  await db.exec(`INSERT INTO folders(folder_id,folder_name,owner_username) VALUES(1,'B folder','BOB');
 INSERT INTO user_folder_state(username,folder_id,expanded) VALUES('BOB',1,false);
 INSERT INTO upload_sessions(upload_id,owner,total_chunks) VALUES('55555555-5555-4555-8555-555555555555','BOB',1);
 INSERT INTO user_activity_events(event_id,username,kind,source) VALUES('66666666-6666-4666-8666-666666666666','BOB','app_visit','server');`)
  await asUser('ALICE', async () => {
    for (const t of [
      'folders',
      'user_folder_state',
      'upload_sessions',
      'user_activity_events',
      'user_activity_daily',
    ])
      expect((await db.query(`SELECT * FROM ${t}`)).rows, t).toEqual([])
    expect((await db.query('UPDATE upload_sessions SET bytes=5 RETURNING upload_id')).rows).toEqual(
      [],
    )
  })
  await asUser('BOB', async () =>
    expect((await db.query('SELECT * FROM upload_sessions')).rows).toHaveLength(1),
  )
})

it('preserves edits in legacy folders but rejects a move to another user folder', async () => {
  await db.exec(
    "INSERT INTO folders(folder_id,folder_name) VALUES(80,'Legacy'); UPDATE events SET folder_id=80 WHERE event_id=1",
  )
  try {
    await asUser('ALICE', async () => {
      expect(
        (
          await db.query(
            "UPDATE events SET event_name='Edited' WHERE event_id=1 RETURNING event_id",
          )
        ).rows,
      ).toHaveLength(1)
      await expect(db.query('UPDATE events SET folder_id=1 WHERE event_id=1')).rejects.toThrow(
        /row-level security/,
      )
    })
  } finally {
    await db.exec(
      'UPDATE events SET folder_id=NULL WHERE event_id=1; DELETE FROM folders WHERE folder_id=80',
    )
  }
})
it('lets the GPU lock a video and publish duration without editing originals or photos', async () => {
  await db.exec(readFileSync('migrations/postgres/202610050001_gpu_photo_publication.sql', 'utf8'))
  await db.exec(`GRANT SELECT ON photos TO personal_photos_video_worker;
 GRANT UPDATE(duration) ON photos TO personal_photos_video_worker;
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path) VALUES(99,1,'v.mov','video','READY','original');
 BEGIN;SET LOCAL ROLE personal_photos_video_worker;`)
  try {
    expect(
      (await db.query('SELECT photo_id FROM photos WHERE photo_id=99 FOR UPDATE')).rows,
    ).toEqual([{ photo_id: 99 }])
    expect(
      (await db.query('UPDATE photos SET duration=10 WHERE photo_id=99 RETURNING duration')).rows,
    ).toHaveLength(1)
    expect(
      (await db.query('UPDATE photos SET duration=10 WHERE photo_id=1 RETURNING duration')).rows,
    ).toEqual([])
    await expect(
      db.query("UPDATE photos SET original_stage_path='changed' WHERE photo_id=99"),
    ).rejects.toThrow(/permission denied/)
  } finally {
    await db.exec('ROLLBACK')
  }
})

it('indexed media lookup respects live ACLs for every path and rejects stale playback', async () => {
  const { mediaLookupSql } = await import('@/lib/media/media-lookup')
  await db.exec(readFileSync('migrations/postgres/202610062200_media_lookup_indexes.sql', 'utf8'))
  await db.exec(readFileSync('migrations/postgres/202610062230_video_path_catalog.sql', 'utf8'))
  await db.exec(`UPDATE photos SET display_stage_path='display/'||photo_id,thumbnail_stage_path='thumbnails/'||photo_id;
    INSERT INTO video_playback(photo_id,original_path,status,stage_path,renditions) VALUES(4,'d','ready','display/video/4', '[{"stage_path":"display/video/720"},{"stage_path":"display/video/1080"}]')
    ON CONFLICT(photo_id) DO UPDATE SET original_path='d',status='ready',stage_path='display/video/4',renditions=EXCLUDED.renditions;`)
  const find = (path: string, user = 'ALICE') => db.query(mediaLookupSql, [path, user, false])
  await asUser('ALICE', async () => {
    for (const path of [
      'a',
      'display/1',
      'thumbnails/1',
      'display/video/4',
      'display/video/720',
      'display/video/1080',
    ])
      expect((await find(path)).rows).toHaveLength(1)
    for (const path of ['b', 'display/2', 'thumbnails/2', 'missing'])
      expect((await find(path)).rows).toHaveLength(0)
  })
  await db.exec('DELETE FROM album_shares WHERE event_id=4')
  await asUser('ALICE', async () => expect((await find('display/video/720')).rows).toHaveLength(0))
  await db.exec("UPDATE video_playback SET original_path='obsolete' WHERE photo_id=4")
  await asUser('BOB', async () =>
    expect((await find('display/video/720', 'BOB')).rows).toHaveLength(0),
  )
  await db.exec("INSERT INTO album_shares(event_id,username,created_by) VALUES(4,'ALICE','BOB')")
})

it('rendition projection tracks updates and deletion without granting application writes', async () => {
  await db.exec(
    `UPDATE video_playback SET renditions='[{"stage_path":"display/replaced"}]' WHERE photo_id=4`,
  )
  await asUser('BOB', async () => {
    expect(
      (await db.query('SELECT stage_path FROM video_rendition_paths WHERE photo_id=4')).rows,
    ).toEqual([{ stage_path: 'display/replaced' }])
    await expect(db.query("INSERT INTO video_rendition_paths VALUES('evil',4)")).rejects.toThrow(
      /permission denied/,
    )
  })
  await db.exec('DELETE FROM video_playback WHERE photo_id=4')
  expect((await db.query('SELECT * FROM video_rendition_paths WHERE photo_id=4')).rows).toEqual([])
})

it('does not cache revoked shares or ownership across statements', async () => {
  await asUser('ALICE', async () => {
    expect((await db.query('SELECT event_id FROM events WHERE event_id=4')).rows).toHaveLength(1)
    await db.exec(
      "RESET ROLE;DELETE FROM album_shares WHERE event_id=4 AND username='ALICE';SET LOCAL ROLE personal_photos_app",
    )
    expect((await db.query('SELECT event_id FROM events WHERE event_id=4')).rows).toHaveLength(0)
    expect((await db.query('SELECT photo_id FROM photos WHERE event_id=4')).rows).toHaveLength(0)
    await db.exec(
      "RESET ROLE;UPDATE events SET owner_username='BOB' WHERE event_id=1;SET LOCAL ROLE personal_photos_app",
    )
    expect(
      (
        await db.query(
          "UPDATE photos SET caption='unauthorized' WHERE event_id=1 RETURNING photo_id",
        )
      ).rows,
    ).toHaveLength(0)
    expect((await db.query('SELECT event_id FROM events WHERE event_id=1')).rows).toHaveLength(0)
  })
})
it('keeps the explicit-share helper identity scoped and unavailable to PUBLIC', async () => {
  await asUser('ALICE', async () => {
    expect((await db.query('SELECT photo_security.shared_events() AS id')).rows).toEqual([
      { id: 4 },
    ])
  })
  await asUser('', async () => {
    expect((await db.query('SELECT photo_security.shared_events() AS id')).rows).toEqual([])
  })
  await db.exec(
    'CREATE ROLE unrelated_permission_probe;GRANT USAGE ON SCHEMA photo_security TO unrelated_permission_probe;SET ROLE unrelated_permission_probe',
  )
  try {
    await expect(db.query('SELECT photo_security.shared_events()')).rejects.toThrow(
      /permission denied/,
    )
  } finally {
    await db.exec('RESET ROLE')
  }
})

it('lets an owner delete an empty folder while protecting another owner and read-only sessions', async () => {
  await db.exec(
    "INSERT INTO folders(folder_id,folder_name,owner_username) VALUES(901,'Empty A','ALICE'),(902,'Empty B','BOB')",
  )
  try {
    await asUser('ALICE', async () => {
      expect(
        (await db.query('DELETE FROM folders WHERE folder_id=901 RETURNING folder_id')).rows,
      ).toEqual([{ folder_id: 901 }])
      expect((await db.query('SELECT folder_id FROM folders WHERE folder_id=901')).rows).toEqual([])
      expect(
        (await db.query('DELETE FROM folders WHERE folder_id=902 RETURNING folder_id')).rows,
      ).toEqual([])
    })
    await asUser(
      'ALICE',
      async () => {
        expect(
          (await db.query('DELETE FROM folders WHERE folder_id=901 RETURNING folder_id')).rows,
        ).toEqual([])
        expect((await db.query('SELECT folder_id FROM folders WHERE folder_id=901')).rows).toEqual([
          { folder_id: 901 },
        ])
      },
      { can_write: 'false' },
    )
  } finally {
    await db.exec('DELETE FROM folders WHERE folder_id IN(901,902)')
  }
})
