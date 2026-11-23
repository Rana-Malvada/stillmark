// Runs the real gateway proxy/grant/delivery code against deterministic origin doubles.
// Measures protocol work, NOT deployed latency, Postgres TPS, or concurrent-user capacity.
import assert from 'node:assert/strict'
import { proxyGallery } from '../../cloudflare-gateway/proxy.mjs'
import { clearMediaLinks } from '../../cloudflare-gateway/media-delivery.mjs'
import { issueThumbnailGrants } from '../../lib/media-grant.mjs'

const env = {
  MEDIA_DELIVERY_MODE: 'enabled',
  MEDIA_GRANT_SIGNING_KEY: 'cd'.repeat(32),
  GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
  GATEWAY_ORIGIN: 'https://isolated.example.test',
  SNOWFLAKE_ORIGIN: 'https://isolated.snowflakecomputing.app',
  SNOWFLAKE_PAT: 'synthetic',
}
const session = { auth0Subject: 'auth0|synthetic', sid: crypto.randomUUID() }
const paths = Array.from(
  { length: 96 },
  (_, i) => `thumbnails/400/${i + 1}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/image.jpg`,
)
const tokens = await issueThumbnailGrants(
  paths,
  { sub: session.auth0Subject, sid: session.sid },
  env.GATEWAY_ORIGIN,
  env.MEDIA_GRANT_SIGNING_KEY,
)
const storage = 'https://example-customer-stage.s3.us-east-2.amazonaws.com/synthetic'
const results = []
for (const enabled of [false, true]) {
  clearMediaLinks()
  const values = new Map()
  globalThis.caches = {
    default: {
      async match(k) {
        return values.get(k.url)?.clone()
      },
      async put(k, v) {
        const bytes = await v.arrayBuffer()
        values.set(k.url, new Response(bytes, { headers: v.headers }))
      },
    },
  }
  let counts = { appAuthorization: 0, signing: 0, storage: 0 }
  const fetcher = async (url) => {
    if (url.startsWith(env.SNOWFLAKE_ORIGIN)) {
      counts.appAuthorization++
      const p = new URL(url).searchParams.get('path')
      return Response.json(
        { path: p, type: 'image/jpeg', revalidateThumbnail: true },
        { headers: { 'x-photo-media-transfer': 'public-sql-v2' } },
      )
    }
    if (url.includes('/api/v2/statements')) {
      counts.signing++
      return Response.json({ data: [[storage]] })
    }
    counts.storage++
    return new Response('synthetic jpeg', {
      headers: { 'content-length': '14', etag: '"immutable-v1"' },
    })
  }
  for (const pass of ['cold', 'warm']) {
    counts = { appAuthorization: 0, signing: 0, storage: 0 }
    for (let start = 0; start < paths.length; start += 6)
      await Promise.all(
        paths.slice(start, start + 6).map(async (path, j) => {
          const params = new URLSearchParams({ path })
          if (enabled) params.set('grant', tokens[start + j])
          const r = await proxyGallery(
            new Request(env.GATEWAY_ORIGIN + '/api/images?' + params),
            {
              ...env,
              MEDIA_GRANTS_ENABLED: String(enabled),
              MEDIA_GRANT_CACHE_ENABLED: String(enabled),
            },
            session,
            fetcher,
          )
          assert.equal(r.status, 200)
          await r.arrayBuffer()
        }),
      )
    results.push({ grants: enabled, pass, thumbnailRequests: 96, ...counts })
    assert.equal(counts.appAuthorization, enabled ? 0 : 96)
    assert.equal(counts.storage, enabled && pass === 'warm' ? 0 : 96)
  }
}
delete globalThis.caches
console.log(
  JSON.stringify(
    {
      scope:
        'local real gateway code; synthetic signing/storage/app responses; no production traffic; no database timing measurement',
      results,
    },
    null,
    2,
  ),
)
