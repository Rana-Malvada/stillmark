import { afterEach, expect, it, vi } from 'vitest'
import { withHeaderDeadline } from '@/lib/request-deadline'
import { databaseClientLifetime } from '@/lib/database/postgres-client-lifetime'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
it('shares one header budget across sequential operations and aborts outstanding work', async () => {
  vi.useFakeTimers()
  vi.stubEnv('BROWSE_REQUEST_TIMEOUT_MS', '1000')
  let observed: AbortSignal | undefined
  const work = withHeaderDeadline(new Request('https://app/api/photos'), async (req) => {
    observed = req.signal
    await new Promise((r) => setTimeout(r, 700))
    await new Promise((_, reject) =>
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }),
    )
    return Response.json({ ok: true })
  })
  await vi.advanceTimersByTimeAsync(1000)
  expect((await work).status).toBe(504)
  expect(observed?.aborted).toBe(true)
})
it('does not abort a healthy media body after headers are returned', async () => {
  vi.useFakeTimers()
  vi.stubEnv('BROWSE_REQUEST_TIMEOUT_MS', '100')
  let observed!: AbortSignal
  const response = await withHeaderDeadline(new Request('https://app/api/images'), async (req) => {
    observed = req.signal
    return new Response('image')
  })
  await vi.advanceTimersByTimeAsync(500)
  expect(observed.aborted).toBe(false)
  expect(await response.text()).toBe('image')
  expect(vi.getTimerCount()).toBe(0)
})
it('destroys canceled clients exactly once and removes normal-release listeners', () => {
  const controller = new AbortController()
  const release = vi.fn()
  const life = databaseClientLifetime({ release }, controller.signal)
  controller.abort()
  life.release()
  expect(release).toHaveBeenCalledExactlyOnceWith(true)
  const other = new AbortController()
  const normal = vi.fn()
  databaseClientLifetime({ release: normal }, other.signal).release()
  other.abort()
  expect(normal).toHaveBeenCalledExactlyOnceWith(false)
})
