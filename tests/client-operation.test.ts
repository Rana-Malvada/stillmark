import { afterEach, expect, it, vi } from 'vitest'
import { clientMutation, clientOperation, UnconfirmedMutationError } from '@/lib/client-operation'
import { isOk } from '@/lib/frontend-response-contracts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it.each(['headers', 'body'])('bounds a stalled %s and aborts its connection', async (phase) => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, init) => {
      signal = init.signal
      return phase === 'headers'
        ? new Promise(() => {})
        : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) })
    }),
  )
  const result = expect(clientOperation('/api/test', {}, 'Failed', isOk, 100)).rejects.toThrow(
    'timed out',
  )
  await vi.advanceTimersByTimeAsync(101)
  await result
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
it('does not replay an ambiguous write and reconciles before reporting uncertainty', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('connection closed'))
  const reconcile = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('fetch', fetch)
  await expect(
    clientMutation('/api/test', { method: 'PATCH' }, 'Failed', isOk, reconcile),
  ).rejects.toBeInstanceOf(UnconfirmedMutationError)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(reconcile).toHaveBeenCalledOnce()
})
it('also reconciles a malformed success and a gateway failure, never assuming rollback', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(new Response('gateway', { status: 504 }))
  vi.stubGlobal('fetch', fetch)
  const reconcile = vi.fn()
  for (let i = 0; i < 2; i++)
    await expect(
      clientMutation('/api/test', { method: 'DELETE' }, 'Failed', isOk, reconcile),
    ).rejects.toBeInstanceOf(UnconfirmedMutationError)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(reconcile).toHaveBeenCalledTimes(2)
})
it('preserves a definitive permission rejection without a reconciliation or retry', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ error: 'Not allowed' }, { status: 403 }))
  vi.stubGlobal('fetch', fetch)
  const reconcile = vi.fn()
  await expect(
    clientMutation('/api/test', { method: 'PATCH' }, 'Failed', isOk, reconcile),
  ).rejects.toMatchObject({ status: 403, message: 'Not allowed' })
  expect(fetch).toHaveBeenCalledOnce()
  expect(reconcile).not.toHaveBeenCalled()
})
it('clears deadlines on success and respects cancellation after body completion', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true })))
  expect(await clientOperation('/api/test', {}, 'Failed', isOk)).toEqual({ ok: true })
  expect(vi.getTimerCount()).toBe(0)
  const controller = new AbortController()
  controller.abort()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true })))
  await expect(
    clientOperation('/api/test', { signal: controller.signal }, 'Failed', isOk),
  ).rejects.toMatchObject({ name: 'AbortError' })
})
