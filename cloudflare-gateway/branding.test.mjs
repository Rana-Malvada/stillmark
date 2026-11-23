import test from 'node:test'
import assert from 'node:assert/strict'
import worker from './worker.mjs'
import { accountLanding } from './customer-accounts.mjs'
import { BRAND_ICON_LINKS, isPublicBrandingRequest } from '../lib/branding.mjs'

const origin = 'https://photos.example.com'
test('anonymous icon GET and HEAD use assets without authentication or Snowflake', async () => {
  for (const method of ['GET', 'HEAD']) {
    let calls = 0
    const response = await worker.fetch(
      new Request(`${origin}/favicon.ico?v=stillmark-amber-1`, { method }),
      {
        GATEWAY_ORIGIN: origin,
        BRANDING_ASSETS: {
          fetch: async () => {
            calls++
            return new Response(method === 'HEAD' ? null : 'icon', {
              headers: { 'Content-Type': 'image/x-icon' },
            })
          },
        },
      },
    )
    assert.equal(response.status, 200)
    assert.equal(calls, 1)
    assert.match(response.headers.get('Cache-Control'), /public/)
  }
})
test('public asset allowance is exact and read-only', () => {
  for (const path of [
    '/api/photos',
    '/private.png',
    '/icon.svg/extra',
    '/public/icon.svg',
    '/theme.css',
  ]) {
    assert.equal(isPublicBrandingRequest(path, 'GET'), false)
  }
  assert.equal(isPublicBrandingRequest('/icon.svg', 'POST'), false)
})
test('landing page includes shared versioned icons and permits same-origin images', async () => {
  const response = accountLanding({})
  assert.ok((await response.text()).includes(BRAND_ICON_LINKS))
  assert.match(response.headers.get('Content-Security-Policy'), /img-src 'self'/)
})
