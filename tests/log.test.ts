import { afterEach, expect, it, vi } from 'vitest'
import { logError, logInfo, logWarn } from '@/lib/log'
import { safeDiagnostic } from '@/lib/observability/production-diagnostics'

afterEach(() => vi.restoreAllMocks())

it('writes a text message as one "[scope] message" string followed by its details', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  logInfo('pg', 'Read password from /secrets/PG_SECRET/password')
  logInfo('pg', 'Connecting to', 'db.test', 'port', '5432', 'user', 'personal_photos_app')
  logWarn('pg', 'Slow checkout', { waitedMs: 12 })
  logError('pg', 'Checkout failed')
  expect(log.mock.calls).toEqual([
    ['[pg] Read password from /secrets/PG_SECRET/password'],
    ['[pg] Connecting to', 'db.test', 'port', '5432', 'user', 'personal_photos_app'],
  ])
  expect(warn.mock.calls).toEqual([['[pg] Slow checkout', { waitedMs: 12 }]])
  expect(error.mock.calls).toEqual([['[pg] Checkout failed']])
})

it('keeps a bare scope tag before an error so production diagnostics still classify it', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const failure = new Error('connection lost')
  logError('postgres-pool', failure)
  expect(error.mock.calls).toEqual([['[postgres-pool]', failure]])
  expect(safeDiagnostic(error.mock.calls[0])).toEqual({ event: 'postgres-pool' })
})
