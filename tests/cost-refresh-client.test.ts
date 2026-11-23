import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { refreshCostUsage } from '../lib/costs/cost-refresh-client'

const fetchMock = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('accepts a completed saved report after a gateway returns HTML instead of JSON', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('<html>timeout</html>', { status: 504 }))
    .mockResolvedValueOnce(Response.json({ asOf: 'old' }))
    .mockResolvedValueOnce(Response.json({ asOf: 'new' }))
  const task = refreshCostUsage('old', new AbortController().signal)
  await vi.runAllTimersAsync()
  await task
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/costs')).toHaveLength(1)
})
it('detects a completed saved report even while the POST remains pending', async () => {
  fetchMock.mockImplementation((url) =>
    url === '/api/costs' ? new Promise(() => {}) : Promise.resolve(Response.json({ asOf: 'new' })),
  )
  const task = refreshCostUsage('old', new AbortController().signal)
  await vi.advanceTimersByTimeAsync(3000)
  await task
})
it('preserves rate limits and authorization errors instead of retrying the refresh', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ error: 'Wait 15 minutes' }, { status: 429 }))
  const task = expect(refreshCostUsage('old', new AbortController().signal)).rejects.toThrow(
    'Wait 15 minutes',
  )
  await vi.runAllTimersAsync()
  await task
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
it('finishes immediately for a successful POST', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ sections: [] }))
  await refreshCostUsage('old', new AbortController().signal)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
it('polls per-source progress only during a manual refresh and stops afterward', async () => {
  const progress = {
    startedAt: 'now',
    updatedAt: 'now',
    sources: [{ key: 'ai', label: 'AI', status: 'running' }],
  }
  fetchMock.mockImplementation((url) =>
    url === '/api/costs'
      ? new Promise(() => {})
      : Promise.resolve(Response.json({ ...progress, asOf: 'new' })),
  )
  const onProgress = vi.fn()
  const task = refreshCostUsage('old', new AbortController().signal, onProgress)
  await vi.advanceTimersByTimeAsync(3000)
  await task
  expect(onProgress).toHaveBeenCalledWith(progress)
  const calls = fetchMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(60000)
  expect(fetchMock).toHaveBeenCalledTimes(calls)
})

it('survives failed polls without repeating the refresh or loading the full report', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('timeout', { status: 504 }))
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    .mockResolvedValueOnce(new Response('<html>bad gateway</html>'))
    .mockResolvedValueOnce(Response.json({ asOf: 'new', sources: [] }))
  const task = refreshCostUsage('old', new AbortController().signal)
  await vi.runAllTimersAsync()
  await task
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    '/api/costs',
    ...Array(4).fill('/api/costs?progress=1'),
  ])
})
it('stops polling when the page leaves without submitting another refresh', async () => {
  const controller = new AbortController()
  fetchMock
    .mockResolvedValueOnce(new Response('timeout', { status: 504 }))
    .mockImplementation(async () => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    })
  const task = expect(refreshCostUsage('old', controller.signal)).rejects.toThrow()
  await vi.runAllTimersAsync()
  await task
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
it('does not retry unauthorized progress reads', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('timeout', { status: 504 }))
    .mockResolvedValueOnce(new Response('', { status: 403 }))
  const task = expect(refreshCostUsage('old', new AbortController().signal)).rejects.toThrow(
    'Sign in again',
  )
  await vi.runAllTimersAsync()
  await task
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
it('stops at an interrupted owner and permits an explicit retry instead of polling for fifteen minutes', async () => {
  fetchMock.mockResolvedValueOnce(new Response('timeout', { status: 504 })).mockResolvedValueOnce(
    Response.json({
      asOf: 'old',
      status: 'interrupted',
      error: 'Previous report kept. Refresh again.',
      sources: [],
    }),
  )
  const task = expect(refreshCostUsage('old', new AbortController().signal)).rejects.toThrow(
    'Previous report kept. Refresh again.',
  )
  await vi.runAllTimersAsync()
  await task
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/costs', '/api/costs?progress=1'])
})
