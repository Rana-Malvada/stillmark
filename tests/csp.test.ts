import { afterEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '../proxy'

afterEach(() => vi.unstubAllEnvs())
it('enforces a fresh script nonce, blocks handlers, and overwrites forged request context', () => {
  vi.stubEnv('NODE_ENV', 'production')
  const make = () =>
    proxy(
      new NextRequest('https://photos.example/events/1?a=1', {
        headers: {
          accept: 'text/html',
          'sf-context-current-user': 'user',
          'sf-context-current-user-token': 'token',
          'x-nonce': 'forged',
          'x-photo-request-method': 'DELETE',
          'x-photo-request-target': '/evil',
        },
      }),
    )
  const first = make()
  const second = make()
  const csp = first.headers.get('Content-Security-Policy')!
  expect(first.headers.get('Content-Security-Policy-Report-Only')).toBeNull()
  expect(csp).toContain("script-src-attr 'none'")
  expect(csp).toContain("'strict-dynamic'")
  const directive = (name: string) =>
    csp
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(name + ' ')) ?? ''
  // Scripts never get the unsafe escapes; only inline style attributes are allowed.
  expect(directive('script-src')).not.toContain('unsafe-inline')
  expect(directive('script-src')).not.toContain('unsafe-eval')
  expect(directive('default-src')).toBe("default-src 'self'")
  expect(directive('connect-src')).toBe("connect-src 'self'")
  expect(directive('form-action')).toBe("form-action 'self'")
  expect(directive('img-src')).toContain('https://basemaps.cartocdn.com')
  expect(directive('img-src')).not.toContain('*.com')
  expect(directive('media-src')).toBe("media-src 'self' blob:")
  expect(directive('style-src')).toBe("style-src 'self' 'unsafe-inline'")
  expect(csp).not.toContain('forged')
  expect(csp).not.toEqual(second.headers.get('Content-Security-Policy'))
  expect(first.headers.get('x-middleware-request-content-security-policy')).toEqual(csp)
  expect(first.headers.get('x-middleware-request-x-photo-request-method')).toBe('GET')
  expect(first.headers.get('x-middleware-request-x-photo-request-target')).toBe('/events/1?a=1')
})
