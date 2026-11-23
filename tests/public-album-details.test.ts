import { beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { transformSync } from 'esbuild'

const db = vi.hoisted(() => ({ one: vi.fn(), query: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgQueryOne: db.one, pgQuery: db.query }))
import { publicPhotoDetails } from '@/lib/photos/public-photo-details'

beforeEach(() => {
  db.one.mockReset().mockResolvedValue({
    source_filename: 'image.jpg',
    latitude: 40,
    longitude: -74,
    camera_model: 'Camera',
    ai_description: 'A family enjoying a sunny afternoon.',
    exif_raw: { GPSLatitude: 40 },
    original_stage_path: 'private',
    caption: 'private',
    person_name: 'private',
  })
  db.query.mockReset().mockResolvedValue([{ name: 'Alex', box: null }])
})
it('omits location, raw metadata and internal/private fields when sharing is disabled', async () => {
  const result = await publicPhotoDetails(
    { event_id: 1, include_location: false, include_people: false },
    3,
  )
  expect(result.details.camera_model).toBe('Camera')
  expect(result.details.ai_description).toBe('A family enjoying a sunny afternoon.')
  expect(result.details).not.toHaveProperty('latitude')
  expect(result.details).not.toHaveProperty('exif_raw')
  expect(result.details).not.toHaveProperty('caption')
  expect(result.details).not.toHaveProperty('original_stage_path')
  expect(result.people).toEqual([])
  expect(db.query).not.toHaveBeenCalled()
  expect(db.one.mock.calls[0][1]).toEqual([3, 1, null])
})
it('includes explicitly enabled GPS and settled people from the capability-scoped function', async () => {
  const result = await publicPhotoDetails(
    { event_id: 1, include_location: true, include_people: true },
    3,
  )
  expect(result.details.latitude).toBe(40)
  expect(result.people).toEqual([{ name: 'Alex', box: null }])
  expect(db.query.mock.calls[0]).toEqual([
    'SELECT name,box FROM photo_security.public_photo_people($1)',
    [3],
  ])
})
it('rejects photos outside the album before fetching people', async () => {
  db.one.mockResolvedValue(null)
  await expect(
    publicPhotoDetails({ event_id: 1, include_location: true, include_people: true }, 9),
  ).rejects.toMatchObject({ status: 404 })
  expect(db.query).not.toHaveBeenCalled()
})
it('ships syntactically valid viewer controls', () => {
  // app/share/[token]/route.ts serves these controls as a module.
  const { code } = transformSync(readFileSync('public/shared-album-info.js', 'utf8'), {
    format: 'cjs',
  })
  expect(() => new Script(code)).not.toThrow()
})
