import { expect, it, vi } from 'vitest'
import { createBuildIdentity } from '@/lib/build-identity'
import { createDiagnosticWriter } from '@/lib/observability/production-diagnostics'

it('reads the immutable build once and ignores request-supplied release data', () => {
  const read = vi.fn(() => 'build_Abc-123\n')
  const identity = createBuildIdentity(read)
  const rows: string[] = []
  const write = createDiagnosticWriter(
    (line) => rows.push(line),
    () => 0,
    identity,
  )
  write('error', ['[request]', { buildId: 'private-user-value' }])
  write('error', ['[postgres-pool]', new Error('secret')])
  expect(rows.map((row) => JSON.parse(row).buildId)).toEqual(['build_Abc-123', 'build_Abc-123'])
  expect(read).toHaveBeenCalledTimes(1)
  expect(rows.join('')).not.toMatch(/secret|private-user-value/)
})
it('fails safely on missing or invalid build files without logging their contents', () => {
  for (const value of ['', 'x'.repeat(65), 'secret / path', 'line\nbreak']) {
    expect(createBuildIdentity(() => value)()).toEqual({})
  }
  const read = vi.fn(() => {
    throw Error('sensitive path')
  })
  const identity = createBuildIdentity(read)
  expect(identity()).toEqual({})
  expect(identity()).toEqual({})
  expect(read).toHaveBeenCalledTimes(1)
})
