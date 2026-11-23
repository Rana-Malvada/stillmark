import { expect, it } from 'vitest'
import { previewSelection } from '@/lib/media/preview-selection'

it('only reuses the currently authorized version, not removed or changed crops', () => {
  const original = previewSelection([1, 2, 3], [], ['faces/a.webp', 'faces/b.webp', 'faces/c.webp'])
  const cached = original.versions.map((version, i) => ({ id: i + 1, version }))
  const result = previewSelection([1, 2, 3], cached, [
    'faces/a.webp',
    null,
    'faces/replacement.webp',
  ])
  expect(result.reusable).toEqual(['faces/a.webp'])
  expect(result.versions[1]).toBeNull()
  expect(result.versions[2]).not.toBe(original.versions[2])
})
it('rejects foreign ids and malformed cache hints', () => {
  for (const cached of [
    null,
    [{ id: 99, version: 'a'.repeat(64) }],
    [{ id: 1, version: 'invalid' }],
    Array(9).fill({ id: 1, version: 'a'.repeat(64) }),
  ])
    expect(() => previewSelection([1], cached, ['faces/a.webp'])).toThrow()
})
