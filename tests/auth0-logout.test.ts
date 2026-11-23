import { afterEach, expect, it, vi } from 'vitest'
import { auth0LogoutUrl } from '@/lib/identity/auth0-logout'

afterEach(() => vi.unstubAllEnvs())
function config() {
  vi.stubEnv('AUTH0_DOMAIN', 'gallery.us.auth0.com')
  vi.stubEnv('AUTH0_GALLERY_CLIENT_ID', 'galleryClient123')
  vi.stubEnv('APP_ORIGIN', 'https://gallery.snowflakecomputing.app')
}
it('ends Auth0 SSO with a fixed app return URL and no credentials', () => {
  config()
  const u = new URL(auth0LogoutUrl())
  expect(u.origin + u.pathname).toBe('https://gallery.us.auth0.com/v2/logout')
  expect(u.searchParams.get('returnTo')).toBe('https://gallery.snowflakecomputing.app/')
  expect([...u.searchParams.keys()].sort()).toEqual(['client_id', 'returnTo'])
})
it('rejects untrusted provider domains and malformed return origins', () => {
  config()
  vi.stubEnv('AUTH0_DOMAIN', 'evil.com')
  expect(() => auth0LogoutUrl()).toThrow()
  config()
  vi.stubEnv('APP_ORIGIN', 'https://user:password@gallery.example')
  expect(() => auth0LogoutUrl()).toThrow()
})
