import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

// Run separate HTTP requests in workerd: Node's shared event loop cannot expose
// promises/timers belonging to a different Cloudflare request context.
test(
  'concurrent cold thumbnails complete in independent worker request contexts',
  { timeout: 20000 },
  async () => {
    const bundle = await build({
      stdin: {
        contents: `
        import { publicStorageUrl } from './media-delivery.mjs';
        const env = { SNOWFLAKE_PAT: 'test-only' };
        async function signer(url, init) {
          await new Promise(resolve => setTimeout(resolve, 30));
          const rows = [...JSON.parse(init.body).statement.matchAll(/GET_PRESIGNED_URL\\([^,]+, '([^']+)'/g)]
            .map(m => 'https://example-customer-stage.s3.us-east-2.amazonaws.com/' + m[1]);
          return Response.json({data: [rows]});
        }
        export default { async fetch(request) {
          const path = 'thumbnails/' + new URL(request.url).pathname.slice(1) + '.jpg';
          return new Response(await publicStorageUrl(path, env, signer));
        }};
      `,
        resolveDir: import.meta.dirname,
        sourcefile: 'media-runtime-fixture.mjs',
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
      }),
    )
    try {
      // Include duplicate cold paths: an in-flight cache is unsafe as well as batching.
      const paths = Array.from({ length: 45 }, (_, i) => String(i % 30))
      const results = await Promise.all(
        paths.map(async (path) => {
          const response = await mf.dispatchFetch('https://test.local/' + path)
          return { status: response.status, body: await response.text(), path }
        }),
      )
      assert.ok(
        results.every((r) => r.status === 200),
        JSON.stringify(results.filter((r) => r.status !== 200)),
      )
      for (const r of results) assert.ok(r.body.endsWith('/thumbnails/' + r.path + '.jpg'))
      const warm = await mf.dispatchFetch('https://test.local/1')
      assert.equal(warm.status, 200)
      assert.ok((await warm.text()).endsWith('/thumbnails/1.jpg'))
    } finally {
      await mf.dispose()
    }
  },
)

test(
  'worker runtime leaves time for fallback after signing or storage stalls',
  { timeout: 15000 },
  async () => {
    const bundle = await build({
      stdin: {
        contents: `
    import { proxyGallery } from './proxy.mjs';
    import { clearMediaLinks } from './media-delivery.mjs';
    const env = { MEDIA_DELIVERY_MODE:'enabled', MEDIA_EDGE_TIMEOUT_MS:'100',
      GATEWAY_ORIGIN:'https://test.local', SNOWFLAKE_ORIGIN:'https://origin.snowflakecomputing.app',
      SNOWFLAKE_PAT:'test-only', GATEWAY_SIGNING_KEY:'ab'.repeat(32) };
    export default {async fetch(request) {
      clearMediaLinks(); let auth = 0;
      const stall = request.headers.get('x-test-stall');
      const response = await proxyGallery(request,env,{auth0Subject:'auth0|test',sid:crypto.randomUUID()},async(url,init)=>{
        if(url.startsWith(env.SNOWFLAKE_ORIGIN)) {
          if(++auth === 1) return Response.json({path:'thumbnails/runtime.jpg',type:'image/jpeg'},
            {headers:{'x-photo-media-transfer':'public-sql-v2'}});
          return new Response('authorized fallback');
        }
        if(url.includes('/api/v2/statements') && stall === 'storage')
          return Response.json({data:[['https://example-customer-stage.s3.us-east-2.amazonaws.com/runtime.jpg']]});
        return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
      });
      response.headers.set('x-test-auth-count',String(auth)); return response;
    }};
  `,
        resolveDir: import.meta.dirname,
        sourcefile: 'deadline-runtime-fixture.mjs',
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
      }),
    )
    try {
      await mf.ready
      for (const stall of ['signing', 'storage']) {
        const started = performance.now()
        const r = await mf.dispatchFetch(
          'https://test.local/api/images?path=thumbnails/runtime.jpg',
          { headers: { 'x-test-stall': stall } },
        )
        assert.equal(r.status, 200)
        assert.equal(r.headers.get('x-test-auth-count'), '2')
        assert.equal(await r.text(), 'authorized fallback')
        assert.ok(
          performance.now() - started < 1500,
          stall + ' must not consume the client deadline',
        )
      }
    } finally {
      await mf.dispose()
    }
  },
)
