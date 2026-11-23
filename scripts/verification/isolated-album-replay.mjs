/** One bounded real album replay, never a production/stress test. Credentials via environment only. */
import assert from 'node:assert/strict'

const origin = new URL(process.env.STILLMARK_REPLAY_ORIGIN ?? 'http://invalid')
assert.equal(origin.protocol, 'https:', 'An isolated HTTPS origin is required')
assert.match(
  origin.hostname,
  /(?:isolated|loadtest)/i,
  'Use an explicitly named isolated/loadtest gateway',
)
assert.equal(origin.username + origin.password, '', 'No URL credentials')
assert.equal(origin.pathname, '/', 'Origin must not contain a path')
assert.equal(origin.search + origin.hash, '', 'Origin must not contain query or fragment')
const event = process.env.STILLMARK_REPLAY_EVENT_ID ?? ''
assert.match(event, /^[1-9][0-9]*$/, 'A synthetic isolated album ID is required')
const cookie = process.env.STILLMARK_REPLAY_COOKIE
assert.ok(cookie && !/[\r\n]/.test(cookie), 'An isolated gateway session cookie is required')
const samples = []
async function read(url, kind, pass) {
  const started = performance.now()
  const r = await fetch(url, {
    headers: { cookie },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
  const headersMs = performance.now() - started
  const bytes = await r.arrayBuffer()
  samples.push({
    kind,
    pass,
    status: r.status,
    headersMs,
    totalMs: performance.now() - started,
    bytes: bytes.byteLength,
    authorization: r.headers.get('x-media-authorization'),
    cache: r.headers.get('x-media-cache'),
    timing: r.headers.get('server-timing'),
  })
  assert.equal(
    r.status,
    200,
    `${kind} request failed (${r.status}); response content is not logged`,
  )
  return bytes
}
const raw = await read(new URL(`/api/events/${event}?paged=true`, origin), 'metadata', 'initial')
const page = JSON.parse(new TextDecoder().decode(raw))
assert.ok(Array.isArray(page.items) && page.items.length <= 96, 'Expected bounded album response')
const urls = page.items.flatMap((p) => (p.thumbnailUrl ? [new URL(p.thumbnailUrl, origin)] : []))
for (const url of urls) {
  assert.equal(url.origin, origin.origin)
  assert.equal(url.pathname, '/api/images')
}
for (const pass of ['first', 'repeat']) {
  for (let i = 0; i < urls.length; i += 6)
    await Promise.all(urls.slice(i, i + 6).map((url) => read(url, 'thumbnail', pass)))
}
// Deliberately omit URLs, tokens, identities, filenames and raw response bodies.
console.log(
  JSON.stringify(
    {
      scope:
        'One isolated album page and two thumbnail passes; no cache purge; first pass may already be warm',
      thumbnailCount: urls.length,
      samples,
    },
    null,
    2,
  ),
)
