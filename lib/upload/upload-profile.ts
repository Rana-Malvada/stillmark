import { databaseContext } from '../database/database-context'
import { AsyncLocalStorage } from 'node:async_hooks'

const profiles = new AsyncLocalStorage<Record<string, number>>()
/** Opt-in profiling for the diagnostic runner; normal requests retain no measurements. */
export async function profileUpload<T>(fn: () => Promise<T>) {
  const timings: Record<string, number> = {}
  const started = performance.now()
  const result = await profiles.run(timings, fn)
  return { result, timings, totalMs: performance.now() - started }
}
export async function uploadStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const timings = profiles.getStore()
  const context = databaseContext.getStore()
  const signal = context?.kind === 'request' ? context.signal : undefined
  signal?.throwIfAborted()
  const started = performance.now()
  try {
    const result = await fn()
    signal?.throwIfAborted()
    return result
  } finally {
    if (timings) timings[name] = (timings[name] ?? 0) + performance.now() - started
  }
}
