import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Immutable runtime artifact identity, not a user/header-supplied release label. */
export function createBuildIdentity(read: () => string) {
  let cached: Readonly<{ buildId?: string }> | undefined
  return () => {
    if (cached) return cached
    let buildId: string | undefined
    try {
      const value = read().trim()
      if (/^[a-zA-Z0-9_-]{1,64}$/.test(value)) buildId = value
    } catch {
      // Local development or a missing artifact must not break error reporting.
    }
    cached = Object.freeze(buildId ? { buildId } : {})
    return cached
  }
}
export const runtimeBuildIdentity = createBuildIdentity(() =>
  readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8'),
)
