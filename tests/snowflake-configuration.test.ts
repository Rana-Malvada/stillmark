import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTomlDefaultConnection, resetTomlConfigCache } from '@/lib/snowflake/connection-config'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stillmark-config-test-'))
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SNOWFLAKE_')) vi.stubEnv(key, undefined)
  }
  vi.stubEnv('SNOWFLAKE_HOME', directory)
  resetTomlConfigCache()
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
  resetTomlConfigCache()
})
it('never substitutes the first saved connection for an explicit unknown connection', () => {
  writeFileSync(join(directory, 'connections.toml'), '[admin]\naccount="admin-account"\n')
  vi.stubEnv('SNOWFLAKE_CONNECTION_NAME', 'missing-test')
  expect(() => readTomlDefaultConnection()).toThrow('refusing fallback')
  expect(() => readTomlDefaultConnection()).toThrow('refusing fallback')
})
it('rejects a missing named connection even when there are no saved connections', () => {
  vi.stubEnv('SNOWFLAKE_CONNECTION_NAME', 'missing-test')
  expect(() => readTomlDefaultConnection()).toThrow('refusing fallback')
})
it('rejects a stale file-level default instead of silently choosing another account', () => {
  writeFileSync(
    join(directory, 'connections.toml'),
    'default_connection_name="deleted"\n[admin]\naccount="admin"\n',
  )
  expect(() => readTomlDefaultConnection()).toThrow('refusing fallback')
})
it('preserves explicit environment selection and connection environment overrides', () => {
  writeFileSync(
    join(directory, 'connections.toml'),
    'default_connection_name="admin"\n[admin]\naccount="admin"\n[test]\naccount="test"\nrole="old"\n',
  )
  vi.stubEnv('SNOWFLAKE_CONNECTION_NAME', 'test')
  vi.stubEnv('SNOWFLAKE_DEFAULT_CONNECTION_NAME', 'admin')
  vi.stubEnv('SNOWFLAKE_ROLE', 'limited-role')
  expect(readTomlDefaultConnection()).toEqual({ account: 'test', role: 'limited-role' })
})
it('prefers nested connections while preserving legacy unconfigured local development', () => {
  writeFileSync(
    join(directory, 'connections.toml'),
    '[test]\naccount="legacy"\n[connections.test]\naccount="nested"\n',
  )
  expect(readTomlDefaultConnection()).toEqual({ account: 'nested' })
})
it('reads config.toml only when connections.toml has no connections', () => {
  writeFileSync(
    join(directory, 'config.toml'),
    'default_connection_name="test"\n[connections.test]\naccount="config-account"\n',
  )
  expect(readTomlDefaultConnection()).toEqual({ account: 'config-account' })
})
