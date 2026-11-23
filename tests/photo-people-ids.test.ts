import pg from 'pg'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseFaceId } from '@/lib/people/face-highlight'

const queries = vi.hoisted(() => ({ one: vi.fn(), rows: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgQueryOne: queries.one, pgQuery: queries.rows }))
import { photoPeople } from '@/lib/people'

beforeEach(() => {
  queries.one.mockResolvedValue({ owns: true, enabled: true })
  queries.rows.mockResolvedValue([
    {
      faceId: pg.types.getTypeParser(20)('123'),
      photoId: 1,
      hasCrop: true,
      source: 'detected',
      status: 'confirmed',
      personName: 'Alex',
      personId: '22222222-2222-4222-8222-222222222222',
      box: { x: 0.1, y: 0.2, w: 0.2, h: 0.3 },
    },
  ])
})
it('matches a People link to production PostgreSQL BIGINT face IDs', async () => {
  const data = await photoPeople(1)
  const requested = parseFaceId('123')
  expect(data.faces.find((face) => face.faceId === requested)).toMatchObject({
    faceId: 123,
    box: { x: 0.1, y: 0.2, w: 0.2, h: 0.3 },
  })
})
it('keeps shared-viewer IDs numeric without exposing face coordinates', async () => {
  queries.one.mockResolvedValue({ owns: false, enabled: false })
  const data = await photoPeople(1)
  expect(data.faces[0].faceId).toBe(123)
  expect(data.faces[0]).not.toHaveProperty('box')
})
