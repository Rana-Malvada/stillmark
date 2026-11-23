import { afterEach, expect, it, vi } from 'vitest'
import { generateVideoThumbnail } from '../lib/video/video-thumbnail'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
function setup() {
  vi.useFakeTimers()
  const video = {
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn(),
    videoWidth: 100,
    videoHeight: 100,
    onseeked: null as null | (() => void),
    onloadeddata: null,
    onerror: null,
  }
  let encode!: (blob: Blob | null) => void
  const canvas = {
    getContext: () => ({
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8Array([255, 255, 255, 255]) }),
    }),
    toBlob: vi.fn((callback) => {
      encode = callback
    }),
  }
  vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'video' ? video : canvas) })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { video, canvas, revoke, encoded: (blob: Blob | null) => encode(blob) }
}
it('retains the overall deadline if the browser never finishes encoding', async () => {
  const { video, canvas, revoke, encoded } = setup()
  const promise = generateVideoThumbnail(new File(['video'], 'test.mov'))
  video.onseeked!()
  await vi.advanceTimersByTimeAsync(300)
  expect(canvas.toBlob).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(19700)
  await expect(promise).resolves.toBeNull()
  encoded(new Blob(['late']))
  expect(revoke).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
it('returns the encoded preview and clears the deadline', async () => {
  const { video, encoded } = setup()
  const promise = generateVideoThumbnail(new File(['video'], 'test.mov'))
  video.onseeked!()
  await vi.advanceTimersByTimeAsync(300)
  const blob = new Blob(['preview'])
  encoded(blob)
  await expect(promise).resolves.toBe(blob)
  expect(vi.getTimerCount()).toBe(0)
})
it('cancels preview creation without waiting for the decoder', async () => {
  const { video, canvas, revoke } = setup()
  const controller = new AbortController()
  const promise = generateVideoThumbnail(new File(['video'], 'test.mov'), controller.signal)
  video.onseeked!()
  controller.abort()
  await expect(promise).resolves.toBeNull()
  await vi.advanceTimersByTimeAsync(300)
  expect(canvas.toBlob).not.toHaveBeenCalled()
  expect(revoke).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
