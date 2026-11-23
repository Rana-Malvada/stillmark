import { afterEach, expect, it, vi } from 'vitest'
import { safeDiagnostic } from '@/lib/observability/production-diagnostics'
import { proxy } from '@/proxy'
import { NextRequest } from 'next/server'

afterEach(() => vi.unstubAllEnvs())
it('never emits arbitrary errors, URLs, query data or identifiers', () => {
  const error = Object.assign(new Error('password=secret https://app/share/token'), {
    code: '23505',
    detail: 'private photo',
  })
  expect(safeDiagnostic(['[request]', error, 'ALICE', { token: 'secret' }])).toEqual({
    event: 'request',
    code: '23505',
  })
  expect(safeDiagnostic(['[ALICE]', new Error('sensitive')])).toEqual({ event: 'application' })
})
it('uses unique script nonces in enforced mode and keeps auth rejection active', () => {
  vi.stubEnv('NODE_ENV', 'production')
  const req = () =>
    new NextRequest('https://app/events/1', {
      headers: {
        accept: 'text/html',
        'sf-context-current-user': 'ALICE',
        'sf-context-current-user-token': 'runtime',
      },
    })
  const a = proxy(req())
  const b = proxy(req())
  expect(a.headers.get('Content-Security-Policy')).toContain("'strict-dynamic'")
  expect(a.headers.get('Content-Security-Policy-Report-Only')).toBeNull()
  expect(a.headers.get('Content-Security-Policy')).not.toEqual(
    b.headers.get('Content-Security-Policy'),
  )
  expect(proxy(new NextRequest('https://app/')).status).toBe(401)
  expect(
    proxy(new NextRequest('https://app/api/events', { headers: req().headers })).headers.get(
      'Content-Security-Policy',
    ),
  ).toBeNull()
})
