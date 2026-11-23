import { runWithSignal } from 'snowflake-sdk/dist/lib/http/stillmark_deadline'
import type { Connection } from 'snowflake-sdk'

export class SnowflakeQueryTimeoutError extends Error {
  constructor() {
    super('Authentication query deadline expired')
    this.name = 'SnowflakeQueryTimeoutError'
  }
}

/** Abort actual transport and retry waits, then await the SDK completion callback. */
export async function withSnowflakeQueryDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('Invalid query deadline')
  const controller = new AbortController()
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  signal.throwIfAborted()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const result = await runWithSignal(signal, () => work(signal))
    parent?.throwIfAborted()
    if (controller.signal.aborted) throw new SnowflakeQueryTimeoutError()
    return result
  } catch (error) {
    parent?.throwIfAborted()
    if (controller.signal.aborted) throw new SnowflakeQueryTimeoutError()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Logout is best effort, but local agent cleanup must finish before discarding. */
export async function discardRoleConnection(
  connection: Connection,
  removeFromPool: (connection: Connection) => Promise<unknown>,
) {
  // Make destruction idempotent for this doomed connection only. generic-pool
  // calls destroy again, and may also create a replacement in the same turn:
  // never put pool.destroy itself inside an aborted async context.
  const originalDestroy = connection.destroy.bind(connection)
  let closing: Promise<void> | undefined
  connection.destroy = (callback) => {
    closing ??= withSnowflakeQueryDeadline(
      2000,
      () => new Promise<void>((resolve) => originalDestroy(() => resolve())),
    ).catch(() => {
      // SDK destroy closes its per-connection agents even when logout fails.
    })
    // oxlint-disable-next-line promise/no-callback-in-promise -- bridges the SDK's callback API
    void closing.then(() => callback?.(undefined, connection))
    return connection
  }
  try {
    await new Promise<void>((resolve) => connection.destroy(() => resolve()))
  } finally {
    await removeFromPool(connection)
  }
}
