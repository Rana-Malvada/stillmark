import { expect, it, vi } from 'vitest'
import { apiError, HttpError, integer, readBody } from '@/lib/http'
import { uploadActiveOperations, withUploadChunkCapacity } from '@/lib/upload/upload-capacity'

it('rejects fractional, absent, and out-of-range IDs', () => {
  for (const value of [null, undefined, NaN, '', -1, 1.2, '1x', Infinity])
    expect(() => integer(value, 'id')).toThrow()
})
it('bounds bodies even when Content-Length is absent', async () => {
  await expect(
    readBody(new Request('https://app', { method: 'POST', body: '12345' }), 4),
  ).rejects.toMatchObject({ status: 413 })
})
it('cancels a stalled upload body and releases its slot without waiting for upstream cleanup', async () => {
  const controller = new AbortController()
  const cancelled = vi.fn(() => new Promise<void>(() => {}))
  const stream = new ReadableStream<Uint8Array>({ cancel: cancelled })
  const request = new Request('https://app', {
    method: 'POST',
    body: stream,
    signal: controller.signal,
    duplex: 'half',
  } as RequestInit)
  const before = uploadActiveOperations()
  const pending = withUploadChunkCapacity(() => readBody(request, 1024), { signal: request.signal })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(stream.locked).toBe(true))
  expect(uploadActiveOperations()).toBe(before + 1)
  controller.abort()
  await rejected
  expect(cancelled).toHaveBeenCalledTimes(1)
  expect(stream.locked).toBe(false)
  expect(uploadActiveOperations()).toBe(before)
})
it('rejects a pre-cancelled body and never accepts a truncated body as complete', async () => {
  const controller = new AbortController()
  const request = new Request('https://app', {
    method: 'POST',
    body: 'partial',
    signal: controller.signal,
  })
  controller.abort()
  await expect(readBody(request, 1024)).rejects.toMatchObject({ name: 'AbortError' })
  expect(request.bodyUsed).toBe(false)
})
it('enforces the byte limit even when upstream cancellation never finishes', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(5))
    },
    cancel() {
      return new Promise<void>(() => {})
    },
  })
  const request = new Request('https://app', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit)
  await expect(readBody(request, 4)).rejects.toMatchObject({ status: 413 })
  expect(stream.locked).toBe(false)
})
it('does not expose internal errors', async () => {
  const response = apiError(new Error('password=hidden'))
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain('hidden')
  expect(apiError(new HttpError(403, 'Forbidden')).status).toBe(403)
})
it('uses explicit authentication codes independently of human-readable wording', async () => {
  expect(
    await apiError(
      new HttpError(401, 'Session is unavailable or revoked', undefined, 'SESSION_REQUIRED'),
    ).json(),
  ).toEqual({ error: 'Session is unavailable or revoked', code: 'SESSION_REQUIRED' })
  expect(
    await apiError(
      new HttpError(401, 'Authentication required', undefined, 'GATEWAY_AUTH_FAILED'),
    ).json(),
  ).toEqual({ error: 'Authentication required', code: 'GATEWAY_AUTH_FAILED' })
  expect(await apiError(new HttpError(401, 'Authentication required')).json()).toEqual({
    error: 'Authentication required',
  })
  expect(await apiError(new HttpError(403, 'No active gallery access')).json()).toMatchObject({
    code: 'ACCESS_DENIED',
  })
})
it('preserves the existing third retry-after argument', async () => {
  const response = apiError(new HttpError(503, 'Search capacity is full', 1))
  expect(response.status).toBe(503)
  expect(response.headers.get('Retry-After')).toBe('1')
  expect(await response.json()).toEqual({ error: 'Search capacity is full' })
})
