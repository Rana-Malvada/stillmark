import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { processIsActive, watchProcessStatus } from '@/lib/status-polling'

let page: EventTarget & { hidden: boolean }
beforeEach(() => {
  vi.useFakeTimers()
  page = Object.assign(new EventTarget(), { hidden: false })
  vi.stubGlobal('document', page)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('sends no idle requests, follows active work and stops at completion', () => {
  const refresh = vi.fn()
  let active = false
  const stop = watchProcessStatus(refresh, () => active)
  vi.advanceTimersByTime(60000)
  expect(refresh).not.toHaveBeenCalled()
  active = true
  vi.advanceTimersByTime(10000)
  expect(refresh).toHaveBeenCalledTimes(2)
  active = false
  vi.advanceTimersByTime(60000)
  expect(refresh).toHaveBeenCalledTimes(2)
  stop()
})
it('checks when returning to a tab, pauses hidden work and removes listeners on unmount', () => {
  const refresh = vi.fn()
  const stop = watchProcessStatus(refresh, () => true)
  page.hidden = true
  page.dispatchEvent(new Event('visibilitychange'))
  vi.advanceTimersByTime(10000)
  expect(refresh).not.toHaveBeenCalled()
  page.hidden = false
  page.dispatchEvent(new Event('visibilitychange'))
  expect(refresh).toHaveBeenCalledTimes(1)
  stop()
  page.dispatchEvent(new Event('visibilitychange'))
  vi.advanceTimersByTime(10000)
  expect(refresh).toHaveBeenCalledTimes(1)
})
it('polls queued and starting jobs but not idle, failed or completed jobs', () => {
  for (const status of ['queued', 'starting', 'running']) expect(processIsActive(status)).toBe(true)
  for (const status of [null, undefined, 'completed', 'failed', 'cancelled'])
    expect(processIsActive(status)).toBe(false)
})
