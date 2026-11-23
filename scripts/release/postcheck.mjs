import { deployment } from '../../config/deployment.mjs'
// Public, read-only production checks. Never supplies fake session credentials.
import assert from 'node:assert/strict'

const base = process.env.RELEASE_URL || deployment.GATEWAY_ORIGIN
for (const path of [
  '/',
  '/api/events',
  '/api/admin/access',
  '/api/photos/1',
  '/api/health/ready',
]) {
  const r = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(20000) })
  if (path === '/') {
    if (r.status === 200) {
      assert.match(r.headers.get('content-type') || '', /text\/html/)
      assert.match(r.headers.get('cache-control') || '', /no-store/)
      const html = await r.text()
      assert.match(html, /<title>Stillmark<\/title>/)
      assert.match(html, /<form action="\/auth\/start" method="get">/)
      assert.match(html, /<button type="submit">Sign in<\/button>/)
      assert.match(html, /name="remember" value="1" checked/)
      assert.ok(html.length < 10000, 'Unexpected public landing content')
    } else {
      assert.equal(r.status, 303, 'Gateway sign-in redirect failed')
      assert.equal(new URL(r.headers.get('location'), base).pathname, '/auth/start')
    }
  } else
    assert.ok(
      [401, 403, 302, 303, 307].includes(r.status),
      `Unexpected anonymous access response: ${path} ${r.status}`,
    )
  console.log(`${path}: ${r.status}`)
}
console.log(
  'Gateway anonymous-access checks passed. Signed-in gallery, photo, video and permission checks still required before accepting release.',
)
