'use client'
import { useSyncExternalStore } from 'react'

const never = () => () => {}

/** A browser-only fact (user agent, storage) that never changes while mounted.
 * Server rendering and hydration see `server`; the browser then reads the real
 * value, so no effect has to copy it into state. `read` must return a primitive. */
export function useClientValue<T extends string | number | boolean | null>(
  read: () => T,
  server: T,
): T {
  return useSyncExternalStore(never, read, () => server)
}
