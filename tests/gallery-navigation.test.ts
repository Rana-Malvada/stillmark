import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, reads: 0 }))
vi.mock('@/lib/postgres', () => ({
  pgQueryOne: async (sql: string, args: unknown[]) => {
    state.reads++
    return (await state.db.query(sql, args)).rows[0]
  },
  pgReadIdentity: async (_caller: unknown, work: () => unknown) => work(),
}))
vi.mock('@/lib/database/postgres-page-rows', () => ({
  pgPageRows: async (sql: string, args: unknown[]) => (await state.db.query(sql, args)).rows,
}))
vi.mock('@/lib/albums/album-access', () => ({
  canEditAlbum: (caller: any, owner: string) => caller.username === owner,
}))
import { authorizedPhotoPage, favoritePhotoPage } from '@/lib/photos/photo-page'
import { isSlideshowPage } from '@/components/gallery/slideshow-data'
import { getAdjacentFavorites, getPhotoViewerPage } from '@/lib/photos'
import { galleryQueryString, galleryReturnPath, galleryViewerContext } from '@/lib/gallery-query'

const caller = { username: 'alice', role: 'viewer' as const, mainAdmin: false }
beforeAll(async () => {
  state.db = new PGlite()
  await state.db
    .exec(`CREATE TABLE events(event_id int,owner_username text,visibility text,event_name text,cover_photo_id int);
    CREATE TABLE album_shares(event_id int,username text);
    INSERT INTO events VALUES(1,'alice','PRIVATE','One',null),(2,'bob','PRIVATE','Other',null);
    CREATE TABLE photos(photo_id int,event_id int,source_filename text,date_taken timestamptz,created_at timestamptz NOT NULL,
      ingest_status text,media_type text,favorite boolean,camera_make text,camera_model text,country text,region text,city text,location_name text,
      display_stage_path text,thumbnail_stage_path text,original_stage_path text,width int,height int,aspect_ratio float,caption text);
    INSERT INTO photos SELECT n,1,'File '||lpad((30-n)::text,2,'0'),CASE WHEN n%4=0 THEN null ELSE '2026-01-01'::timestamptz+(n%5)*interval '1 day' END,
      '2026-01-01'::timestamptz+(n%7)*interval '1 day',CASE WHEN n=8 THEN 'FAILED' ELSE 'READY' END,
      CASE WHEN n%3=0 THEN 'video' ELSE 'photo' END,n%2=0,'Canon','Model', 'France',null,CASE WHEN n%3=1 THEN 'Paris' ELSE 'Lyon' END,null,
      'display/'||n,null,null,100,100,1,null FROM generate_series(1,24)n;
    INSERT INTO photos SELECT 999,2,'Outside','2026-01-01','2026-01-01','READY','photo',true,null,null,null,null,null,null,'outside',null,null,100,100,1,null;`)
})
afterAll(async () => state.db?.close())
it('serializes legacy null media types as photos for the actual slideshow page contract', async () => {
  await state.db.exec('UPDATE photos SET media_type=NULL WHERE photo_id=1')
  try {
    const page = await authorizedPhotoPage(1, new URLSearchParams(), caller)
    const wire = JSON.parse(JSON.stringify(page))
    expect(wire.items.find((photo: { photoId: number }) => photo.photoId === 1).mediaType).toBe(
      'photo',
    )
    expect(wire.items.find((photo: { photoId: number }) => photo.photoId === 3).mediaType).toBe(
      'video',
    )
    expect(isSlideshowPage(wire)).toBe(true)
  } finally {
    await state.db.exec("UPDATE photos SET media_type='photo' WHERE photo_id=1")
  }
})
it('canonical gallery context carries only gallery keys and returns to the correct filtered list', () => {
  const query = galleryQueryString(
    new URLSearchParams(
      'sort=newest&media=photo&favorite=true&location=Paris&cursor=secret&context=other',
    ),
  )
  expect(query).toBe('sort=newest&media=photo&favorite=true&location=Paris')
  expect(galleryReturnPath(1, galleryViewerContext(query, false))).toBe(`/events/1?${query}`)
  expect(galleryReturnPath(1, galleryViewerContext(query, true))).toBe(`/favorites?${query}`)
})
for (const sort of ['oldest', 'newest', 'name', 'uploaded']) {
  for (const filter of [
    '',
    'media=photo',
    'media=video',
    'favorite=true',
    'from=2026-01-02&to=2026-01-04',
    'camera=canon',
    'location=Paris',
  ]) {
    it(`${sort} ${filter || 'all'}: viewer seeks exactly follow paged gallery and preserve bounded preload`, async () => {
      const params = new URLSearchParams(`sort=${sort}&${filter}`)
      const grid = (await authorizedPhotoPage(1, params, caller)).items
      for (let i = 0; i < grid.length; i++) {
        const expected = {
          prev: grid[i - 1]?.photoId ?? null,
          next: grid[i + 1]?.photoId ?? null,
          next2: grid[i + 2]?.photoId ?? null,
        }
        const before = state.reads
        const direct = await getPhotoViewerPage(grid[i].photoId, caller, params)
        expect(state.reads - before).toBe(1)
        expect(direct?.adjacent).toEqual(expected)
        expect(direct!.candidates.length).toBeLessThanOrEqual(3)
        expect(direct!.candidates.every((p) => Object.values(expected).includes(p.photo_id))).toBe(
          true,
        )
      }
      const favorites = (await favoritePhotoPage(params, caller)).items
      for (let i = 0; i < favorites.length; i++)
        expect(await getAdjacentFavorites(favorites[i].photoId, params, [1], true)).toEqual({
          prev: favorites[i - 1]?.photoId ?? null,
          next: favorites[i + 1]?.photoId ?? null,
          next2: favorites[i + 2]?.photoId ?? null,
        })
      expect(await getPhotoViewerPage(999, caller, params)).toBeNull()
    })
  }
}
