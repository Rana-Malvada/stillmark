'use client'
import { useEffect, useState } from 'react'
import { createScopedMutation } from './scoped-mutation'

/** Keeps pending writes isolated from later navigation without replaying any write. */
export function useGalleryMutation(scope: string) {
  const [, refresh] = useState(0)
  const [mutation] = useState(() => createScopedMutation(() => refresh((n) => n + 1)))
  mutation.setScope(scope)
  useEffect(() => {
    mutation.activate()
    return () => mutation.dispose()
  }, [mutation])
  return { busy: mutation.busy(), run: mutation.run, isCurrent: mutation.currentScope() }
}
