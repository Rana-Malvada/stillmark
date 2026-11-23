import { expect, it, vi } from 'vitest'
import { hydrateRankedPhotos } from '@/lib/search/search-hydration'
import {
  prioritizePhotoEvidence,
  protectEvidence,
  supportedEvidence,
} from '@/lib/search/search-evidence'

it.each(['rider number 6', 'people eating at a restaurant', 'plate ABC123'])(
  'matches full-list ranking for %s with late evidence and missing rows',
  async (query) => {
    const ids = Array.from({ length: 2401 }, (_, i) => i + 1)
    const rows = ids
      .filter((id) => id % 13 !== 0)
      .map((photoId) => ({
        photoId,
        subjectMatch: photoId % 7 === 0,
        aiDescription:
          photoId % 3 === 0
            ? 'A rider number 6 eating at a restaurant, plate ABC123.'
            : 'Rider number 57 near a menu.',
        ocrText: photoId % 11 === 0 ? '6 ABC123' : '',
      }))
    const byId = new Map(rows.map((row) => [row.photoId, row]))
    const load = vi.fn(async (batch: number[]) =>
      batch.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    )
    const actual = await hydrateRankedPhotos(query, ids, 57, load)
    const expected = supportedEvidence(
      query,
      protectEvidence(query, prioritizePhotoEvidence(rows)),
    ).slice(0, 57)
    expect(actual).toEqual(expected)
    expect(load).toHaveBeenCalledTimes(13)
    expect(load.mock.calls.every(([batch]) => batch.length <= 200)).toBe(true)
    expect(load.mock.calls.flatMap(([batch]) => batch)).toEqual(ids)
  },
)

it('does not discard a confirmed late number match behind unsupported early candidates', async () => {
  const ids = Array.from({ length: 1001 }, (_, i) => i + 1)
  const actual = await hydrateRankedPhotos('motocross rider number 6', ids, 20, async (batch) =>
    batch.map((photoId) => ({
      photoId,
      aiDescription: photoId === 1001 ? 'Motocross rider number 6.' : 'Motocross rider number 57.',
    })),
  )
  expect(actual.map((row) => row.photoId)).toEqual([1001])
})

it('does not schedule the next hydration batch after cancellation', async () => {
  const controller = new AbortController()
  const load = vi.fn(async () => {
    controller.abort()
    return []
  })
  await expect(
    hydrateRankedPhotos(
      'cars',
      Array.from({ length: 401 }, (_, i) => i + 1),
      50,
      load,
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(load).toHaveBeenCalledTimes(1)
})

it('propagates failures rather than reporting incomplete candidates as complete', async () => {
  const load = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('query failed'))
  await expect(
    hydrateRankedPhotos(
      'cars',
      Array.from({ length: 401 }, (_, i) => i + 1),
      50,
      load,
    ),
  ).rejects.toThrow('query failed')
  expect(load).toHaveBeenCalledTimes(2)
})
