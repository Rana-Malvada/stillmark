import { afterEach, expect, it, vi } from 'vitest'

const record = vi.hoisted(() => vi.fn())
vi.mock('@/lib/observability/performance-metrics', () => ({ recordPerformance: record }))
import { observeResponseBody } from '@/lib/response-body-observation'

const state = { id: '11111111-1111-4111-8111-111111111111', route: 'media' }
afterEach(() => vi.clearAllMocks())
it('streams unchanged bytes and records completion once without pre-reading', async () => {
  let reads = 0
  const response = new Response(
    new ReadableStream(
      {
        pull(c) {
          reads++
          c.enqueue(new Uint8Array([1, 2, 3]))
          c.close()
        },
      },
      { highWaterMark: 0 },
    ),
    { status: 206, headers: { 'content-range': 'bytes 0-2/3' } },
  )
  const observed = observeResponseBody(response, state)
  expect(reads).toBe(0)
  expect(observed.status).toBe(206)
  expect(observed.headers.get('content-range')).toBe('bytes 0-2/3')
  expect([...new Uint8Array(await observed.arrayBuffer())]).toEqual([1, 2, 3])
  expect(record).toHaveBeenCalledExactlyOnceWith('body:media', expect.any(Number), 0, false)
})
it('cancellation reaches upstream and is measured without retry', async () => {
  const cancel = vi.fn()
  const response = observeResponseBody(
    new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })),
    state,
  )
  await response.body!.cancel('gone')
  expect(cancel).toHaveBeenCalledOnce()
  expect(record).toHaveBeenCalledExactlyOnceWith('body:media', expect.any(Number), 0, true)
})
it('body errors propagate and retain failure accounting', async () => {
  const response = observeResponseBody(
    new Response(
      new ReadableStream(
        {
          pull(c) {
            c.error(new Error('private upstream detail'))
          },
        },
        { highWaterMark: 0 },
      ),
    ),
    state,
  )
  await expect(response.arrayBuffer()).rejects.toThrow('private upstream detail')
  expect(record).toHaveBeenCalledExactlyOnceWith('body:media', expect.any(Number), 0, true)
})
