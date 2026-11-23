'use client'
import { useState } from 'react'

/** True on the render in which any value differs from the previous render's.
 * Callers reset dependent state in that same render (React re-renders at once),
 * so stale state is never committed and no effect is needed for the reset.
 * False on the first render. */
export function useChanged(...values: unknown[]): boolean {
  const [previous, setPrevious] = useState(values)
  const changed =
    values.length !== previous.length ||
    values.some((value, index) => !Object.is(value, previous[index]))
  if (changed) setPrevious(values)
  return changed
}
