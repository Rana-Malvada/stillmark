import { describe, expect, it, vi } from 'vitest'
import { createStatusLoader } from '../lib/status-loader'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
describe('processing status request ordering', () => {
  it('deduplicates healthy reads without introducing extra requests', async () => {
    const response = deferred<string>()
    const apply = vi.fn()
    const read = vi.fn(() => response.promise)
    const loader = createStatusLoader({ read, apply, loading: vi.fn() })
    const a = loader.refresh()
    const b = loader.refresh()
    expect(a).toBe(b)
    response.resolve('idle')
    await a
    expect(read).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('idle')
  })
  for (const failed of [false, true])
    it(`fetches committed state after a stale ${failed ? 'failed' : 'successful'} read`, async () => {
      const stale = deferred<string>()
      const fresh = deferred<string>()
      const apply = vi.fn()
      const read = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
      const loader = createStatusLoader<string>({ read, apply, loading: vi.fn() })
      const first = loader.refresh()
      await Promise.resolve()
      const after = loader.refreshAfterMutation()
      if (failed) stale.reject(new Error('old network failure'))
      else stale.resolve('idle')
      await first
      await Promise.resolve()
      await Promise.resolve()
      expect(apply).not.toHaveBeenCalled()
      fresh.resolve('running')
      await after
      expect(read).toHaveBeenCalledTimes(2)
      expect(apply).toHaveBeenCalledExactlyOnceWith('running')
    })
  it('does not commit after unmount, and supports a new effect lifetime', async () => {
    const old = deferred<string>()
    const fresh = deferred<string>()
    const apply = vi.fn()
    const loading = vi.fn()
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const loader = createStatusLoader<string>({ read, apply, loading })
    const first = loader.refresh()
    await Promise.resolve()
    loader.cancel()
    old.resolve('old')
    await first
    await loader.refreshAfterMutation()
    expect(apply).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(1)
    loader.activate()
    const next = loader.refresh()
    fresh.resolve('fresh')
    await next
    expect(apply).toHaveBeenCalledExactlyOnceWith('fresh')
  })
  it('starts a post-mutation read immediately even if the old transport ignores abort', async () => {
    const old = deferred<string>()
    const fresh = deferred<string>()
    const apply = vi.fn()
    let firstSignal: AbortSignal | undefined
    const read = vi.fn((signal: AbortSignal) => {
      if (!firstSignal) {
        firstSignal = signal
        return old.promise
      }
      return fresh.promise
    })
    const loader = createStatusLoader({ read, apply, loading: vi.fn() })
    const first = loader.refresh()
    await Promise.resolve()
    const after = loader.refreshAfterMutation()
    await Promise.resolve()
    expect(firstSignal?.aborted).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
    fresh.resolve('running')
    await after
    old.resolve('idle')
    await first
    expect(apply).toHaveBeenCalledExactlyOnceWith('running')
  })
})
