import type { CallerIdentity } from '../identity/auth'
import { AsyncLocalStorage } from 'node:async_hooks'

export type DatabaseIdentity = {
  username: string
  mainAdmin: boolean
  adminRead: boolean
  adminWrite: boolean
  canWrite: boolean
  accessManager: boolean
}
export type DatabaseContext =
  | {
      kind: 'request'
      signal?: AbortSignal
      requestBinding?: { method: string; target: string }
      gatewayMediaLookup?: { username: string; path: string; row: unknown | null }
      identity?: Promise<DatabaseIdentity>
      gatewayBootstrap?: Promise<
        { name: string; marker: string; revoked: boolean; epoch: string } | undefined
      >
      auth?: Promise<CallerIdentity>
      caller?: Promise<CallerIdentity>
      freshCaller?: Promise<CallerIdentity>
      nativeMainAdmin?: { username: string; allowed: boolean }
    }
  | { kind: 'service'; signal?: AbortSignal }
  | { kind: 'public'; hash: string; signal?: AbortSignal }
  | { kind: 'anonymous'; signal?: AbortSignal }
export const databaseContext = new AsyncLocalStorage<DatabaseContext>()
/** Scope only identity, never a connection: external work does not hold transactions open. */
export function withDatabaseRequest<A extends unknown[], R>(fn: (...args: A) => R) {
  return (...args: A): R =>
    databaseContext.run(
      { kind: 'request', signal: args[0] instanceof Request ? args[0].signal : undefined },
      () => fn(...args),
    )
}
/** Explicit trusted maintenance entry points only. Uses a separate database credential. */
export function withServiceDatabase<T>(fn: () => T, signal?: AbortSignal): T {
  return databaseContext.run({ kind: 'service', signal }, fn)
}
export function withPublicDatabase<T>(hash: string, fn: () => T, signal = databaseSignal()): T {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid public database capability')
  return databaseContext.run({ kind: 'public', hash, signal }, fn)
}
export function withAnonymousDatabase<T>(fn: () => T): T {
  return databaseContext.run({ kind: 'anonymous', signal: databaseSignal() }, fn)
}

/** Background service work is detached by default; synchronous service reads may opt in. */
export function databaseSignal(): AbortSignal | undefined {
  const context = databaseContext.getStore()
  return context?.signal
}
