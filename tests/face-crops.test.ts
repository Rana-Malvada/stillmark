import { createTestDatabase } from './fixtures/test-database'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  db: null as import('@electric-sql/pglite').PGlite | null,
  user: 'ALICE',
  publicHash: '',
  sf: vi.fn(),
}))
vi.mock('@/lib/postgres', () => ({
  pgQueryOne: async (sql: string, params: unknown[] = []) => {
    const db = state.db!
    await db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
    try {
      await db.query("SELECT set_config('photos.username',$1,true)", [state.user])
      await db.query("SELECT set_config('photos.public_hash',$1,true)", [state.publicHash])
      return (await db.query(sql, params)).rows[0] ?? null
    } finally {
      await db.exec('ROLLBACK')
    }
  },
}))
vi.mock('@/lib/snowflake', () => ({ querySnowflakeStorage: state.sf, querySnowflake: state.sf }))
vi.mock('@/lib/identity/auth', () => ({
  requireAuth: vi.fn(async () => ({ username: state.user })),
}))
import { storageUrlSigner } from '@/lib/snowflake/storage-url-signer'
import { mediaStage } from '@/lib/snowflake/media-stage'
import { signCrop, validateCropPath, visibleCrop } from '@/lib/people/face-crops'
import { GET } from '@/app/api/faces/[faceId]/crop/route'

const CROP = 'faces/0b6c1a52-7f0e-4a7e-9a55-3f5d2f1c9e10.webp'
const fetchMock = vi.fn()
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
        sql: `SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app;
 GRANT SELECT ON events,photos,album_shares,album_public_links TO personal_photos_app;
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES(1,1,'A','a','ALICE','PRIVATE');
 INSERT INTO album_shares(event_id,username,created_by) VALUES(1,'CAROL','ALICE');
 INSERT INTO album_public_links(id,event_id,token_hash,owner_username,created_by,expires_at)
  VALUES('11111111-1111-4111-8111-111111111111',1,repeat('a',64),'ALICE','ALICE',now()+interval '1 hour');`,
      },
      'setup/72-app-rls.sql',
      '202610072000_people_faces',
      {
        sql: `INSERT INTO face_settings(owner_username,enabled) VALUES('ALICE',true);
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path) VALUES(1,1,'a.jpg','photo','READY','o/1');
 INSERT INTO face_people(person_id,owner_username,name) VALUES('22222222-2222-4222-8222-222222222222','ALICE','Dana');
 INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding,crop_path)
  VALUES(1,'ALICE','detected','o/1','m',0,0.1,0.1,0.2,0.2,0.9,0.9,true,'[1,0]','${CROP}'),
        (1,'ALICE','detected','o/1','m',1,0.5,0.1,0.2,0.2,0.9,0.9,true,'[0,1]','faces/../../originals/x.jpg');
 INSERT INTO face_assignments(face_id,person_id,owner_username,status) VALUES(1,'22222222-2222-4222-8222-222222222222','ALICE','confirmed');`,
      },
    ],
  })
}, 60000)
afterAll(async () => state.db?.close())
beforeEach(() => {
  storageUrlSigner.invalidate(`GET_PRESIGNED_URL(${mediaStage(CROP)}, '${CROP}', 300)`)
  state.user = 'ALICE'
  state.publicHash = ''
  state.sf.mockReset()
  state.sf.mockResolvedValue([{ URL0: 'https://stage.example/crop?sig=1' }])
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response('webp-bytes', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
const request = (id: string | number) =>
  GET(new Request(`https://app/api/faces/${id}/crop`), {
    params: Promise.resolve({ faceId: String(id) }),
  })

describe('face crop route', () => {
  it('serves the owner a private, uncached crop from the derived stage', async () => {
    const response = await request(1)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-type')).toBe('image/webp')
    const timing = response.headers.get('server-timing')!
    for (const stage of ['session', 'visibility', 'signing', 'storage_headers'])
      expect(timing).toMatch(new RegExp(`${stage};dur=\\d+\\.\\d`))
    expect(timing).not.toContain(CROP)
    expect(timing).not.toContain('sig=')
    expect(await response.text()).toBe('webp-bytes')
    expect(state.sf.mock.calls[0][0]).toContain('@PERSONAL_MEDIA.RAW.DERIVED_FILES')
    expect(state.sf.mock.calls[0][0]).toContain(`'${CROP}', 300)`)
  })
  it('hides crops from shared viewers until the owner shares names', async () => {
    state.user = 'CAROL'
    expect((await request(1)).status).toBe(404)
    await state.db!.exec(`UPDATE face_settings SET share_names=true WHERE owner_username='ALICE'`)
    expect((await request(1)).status).toBe(200)
    await state.db!.exec(`UPDATE face_settings SET share_names=false WHERE owner_username='ALICE'`)
    expect((await request(1)).status).toBe(404)
    expect(state.sf).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('never serves public links or strangers', async () => {
    await state.db!.exec(`UPDATE face_settings SET share_names=true WHERE owner_username='ALICE'`)
    state.user = ''
    state.publicHash = 'a'.repeat(64)
    expect((await request(1)).status).toBe(404)
    state.user = 'MALLORY'
    state.publicHash = ''
    expect((await request(1)).status).toBe(404)
    await state.db!.exec(`UPDATE face_settings SET share_names=false WHERE owner_username='ALICE'`)
    expect(state.sf).not.toHaveBeenCalled()
  })
  it('shows ignored crops only to their owner', async () => {
    await state.db!.exec('UPDATE faces SET ignored=true WHERE face_id=1')
    expect((await request(1)).status).toBe(200)
    state.user = 'CAROL'
    await state.db!.exec("UPDATE face_settings SET share_names=true WHERE owner_username='ALICE'")
    expect((await request(1)).status).toBe(404)
    state.user = 'BOB'
    expect((await request(1)).status).toBe(404)
    await state.db!.exec("UPDATE face_settings SET share_names=false WHERE owner_username='ALICE'")
    await state.db!.exec('UPDATE faces SET ignored=false WHERE face_id=1')
  })
  it('refuses to sign anything but a worker crop name, even if stored', async () => {
    expect((await request(2)).status).toBe(400)
    expect(state.sf).not.toHaveBeenCalled()
    for (const bad of [
      'originals/a.jpg',
      'faces/x.webp',
      `${CROP}'`,
      'faces/../a.webp',
      `/${CROP}`,
    ])
      expect(() => validateCropPath(bad), bad).toThrow()
    await expect(signCrop('display/a.jpg')).rejects.toThrow()
    await expect(visibleCrop(999)).rejects.toMatchObject({ status: 404 })
  })
  it('rejects malformed ids', async () => {
    expect((await request('1 OR 1=1')).status).toBe(400)
    expect((await request(0)).status).toBe(400)
  })
})
