import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

test(
  'workerd log recovery reaches provider and refuses credential-bearing redirects',
  { timeout: 30000 },
  async () => {
    let mode = 'success'
    const requests = []
    const bundle = await build({
      stdin: {
        contents: `
        import { CredentialLogPoll } from './credential-log-poll.mjs';
        export default { async fetch(request,env) {
          const data=new Map();let enqueued=0;
          const ctx={storage:{get:async key=>data.get(key),put:async(key,value)=>data.set(key,value)}};
          const poll=new CredentialLogPoll(ctx,env,async()=>{enqueued++;return Response.json({durable:true},{status:202})});
          return Response.json({status:await poll.poll(),enqueued});
        }};
      `,
        resolveDir: import.meta.dirname,
        sourcefile: 'credential-log-poll-runtime-fixture.mjs',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
    })
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: '2026-09-17',
        bindings: {
          AUTH0_LOG_POLL_ENABLED: 'true',
          AUTH0_LOG_TENANT_DOMAIN: 'tenant.us.auth0.com',
          AUTH0_DOMAIN: 'login.example.com',
          AUTH0_LOG_CLIENT_ID: 'synthetic-client',
          AUTH0_LOG_CLIENT_SECRET: 'synthetic-secret',
        },
        outboundService: async (request) => {
          const url = new URL(request.url)
          requests.push({ host: url.hostname, path: url.pathname })
          assert.equal(
            url.hostname,
            'tenant.us.auth0.com',
            'Credentials must never follow a redirect',
          )
          if (
            (mode === 'redirect-token' && url.pathname === '/oauth/token') ||
            (mode === 'redirect-logs' && url.pathname === '/api/v2/logs')
          )
            return new Response(null, {
              status: 302,
              headers: { location: 'https://untrusted.example/credentials' },
            })
          if (url.pathname === '/oauth/token') {
            assert.equal((await request.json()).client_secret, 'synthetic-secret')
            return Response.json({
              access_token: 'synthetic-token',
              expires_in: 86400,
              token_type: 'Bearer',
            })
          }
          assert.equal(request.headers.get('authorization'), 'Bearer synthetic-token')
          if (!url.searchParams.has('from'))
            return Response.json([
              {
                log_id: '1',
                type: 'scp',
                user_id: 'auth0|synthetic',
                date: new Date(Date.now() - 60000).toISOString(),
              },
            ])
          return Response.json([], {
            headers: {
              link: '<https://tenant.us.auth0.com/api/v2/logs?from=1&take=100>; rel="next"',
            },
          })
        },
      }),
    )
    try {
      let result = await (await mf.dispatchFetch('https://fixture.local/poll')).json()
      assert.equal(result.status.healthy, true)
      assert.equal(result.enqueued, 1)
      assert.equal(requests.length, 3)
      for (const [scenario, error, expectedCalls] of [
        ['redirect-token', 'authorization', 1],
        ['redirect-logs', 'retrieval', 2],
      ]) {
        mode = scenario
        requests.length = 0
        result = await (await mf.dispatchFetch('https://fixture.local/poll')).json()
        assert.equal(result.status.healthy, false)
        assert.equal(result.status.error, error)
        assert.equal(result.enqueued, 0)
        assert.equal(requests.length, expectedCalls)
      }
    } finally {
      await mf.dispose()
    }
  },
)
