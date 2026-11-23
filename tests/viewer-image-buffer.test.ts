import { afterEach, expect, it, vi } from 'vitest'
import { preloadWindow, ViewerImageBuffer } from '@/lib/viewer-image-buffer'

const photo = (photoId: number) => ({
  photoId,
  url: `/api/images?path=display/${photoId}.jpg`,
  width: 2000,
  height: 1500,
})
function setup() {
  const created: any[] = []
  const buffer = new ViewerImageBuffer(() => {
    const img = {
      complete: true,
      naturalWidth: 2000,
      naturalHeight: 1500,
      removeAttribute: vi.fn(),
      remove: vi.fn(),
    }
    created.push(img)
    return img as unknown as HTMLImageElement
  })
  return { buffer, created }
}
afterEach(() => vi.useRealTimers())
it('reuses the exact preloaded element for Next/Back and retains at most four images', () => {
  const { buffer, created } = setup()
  buffer.select('alice:album', [photo(1), photo(2), photo(3)])
  const first = buffer.get(photo(1), 'high')
  const next = buffer.get(photo(2), 'low')
  buffer.get(photo(3), 'low')
  buffer.select('alice:album', [photo(2), photo(3), photo(4), photo(1)])
  expect(buffer.get(photo(2), 'high')).toBe(next)
  buffer.get(photo(4), 'low')
  expect(buffer.get(photo(1), 'high')).toBe(first)
  expect(buffer.get(photo(5), 'low')).toBeNull()
  expect(created).toHaveLength(4)
  buffer.select('alice:album', [photo(3), photo(4), photo(5), photo(2)])
  expect(created[0].removeAttribute).toHaveBeenCalledWith('src')
  expect(buffer.get(photo(5), 'low')).not.toBeNull()
  buffer.clear()
})
it('clears on identity/context changes, expiration and explicit logout', () => {
  vi.useFakeTimers()
  const { buffer, created } = setup()
  buffer.select('alice:album', [photo(1)])
  const first = buffer.get(photo(1), 'high')
  buffer.select('bob:album', [photo(1)])
  expect(buffer.get(photo(1), 'high')).not.toBe(first)
  expect(created[0].remove).toHaveBeenCalled()
  buffer.release()
  vi.advanceTimersByTime(30_001)
  expect(created[1].remove).toHaveBeenCalled()
  buffer.clear()
})
it('cancels cleanup across route transitions and replaces changed or failed sources', () => {
  vi.useFakeTimers()
  const { buffer } = setup()
  buffer.select('alice', [photo(1)])
  const first = buffer.get(photo(1), 'high')!
  buffer.release()
  buffer.select('alice', [photo(1)])
  vi.advanceTimersByTime(30_001)
  expect(buffer.get(photo(1), 'high')).toBe(first)
  const changed = { ...photo(1), url: '/api/images?path=display/new.jpg' }
  buffer.select('alice', [changed])
  const replacement = buffer.get(changed, 'high')!
  expect(replacement).not.toBe(first)
  Object.assign(replacement, { naturalWidth: 0 })
  expect(buffer.get(changed, 'high')).not.toBe(replacement)
  buffer.clear()
})
it('caps speculative decoded pixels and never rewrites image URLs or downloads the entire album', () => {
  expect(preloadWindow(photo(1), [photo(2), photo(3), photo(4), photo(5)])).toEqual([
    photo(2),
    photo(3),
    photo(4),
  ])
  expect(preloadWindow(photo(1), [{ ...photo(2), width: 12000, height: 8000 }, photo(3)])).toEqual([
    photo(3),
  ])
})

it('budgets loaded display dimensions instead of rejecting large-original neighbors', () => {
  const { buffer } = setup()
  const large = (id: number) => ({ ...photo(id), width: 5712, height: 4284 })
  buffer.select('alice', [large(1), large(2), large(3), large(4)])
  buffer.get(large(1), 'high')
  expect(preloadWindow(buffer.dimensions(large(1)), [large(2), large(3)])).toEqual([large(2)])
  buffer.get(large(2), 'low')
  expect(
    preloadWindow(buffer.dimensions(large(1)), [buffer.dimensions(large(2)), large(3)]),
  ).toHaveLength(2)
  buffer.clear()
})
