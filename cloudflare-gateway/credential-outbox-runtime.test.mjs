import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

test(
  'real SQLite Durable Object commits event/alarm and recovers after isolate restart',
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'credential-recovery-'))
    const bundle = await build({
      stdin: {
        contents: `
    import { EmailAlerts } from './alerts.mjs';
    export class RecoveryFixture extends EmailAlerts {
      constructor(ctx,env) {
        super(ctx,env);
        this.credentials.deliver=async event=>{
          if(!await ctx.storage.get('test-allow')) throw Error('synthetic persistence outage');
          await ctx.storage.put('test-delivered',event.changedAt);
        };
      }
      async fetch(request) {
        const path=new URL(request.url).pathname;
        if(path==='/test-replay') {
          await this.ctx.storage.put('test-allow',true);
          const rows=await this.ctx.storage.list({prefix:'pending:'});
          for(const [key,event] of rows) await this.ctx.storage.put(key,{...event,nextAttempt:0});
          await this.alarm();
          return Response.json({delivered:await this.ctx.storage.get('test-delivered')});
        }
        return super.fetch(request);
      }
    }
    export default {fetch(request,env){return env.EMAIL_ALERTS.get(env.EMAIL_ALERTS.idFromName('credential-events')).fetch(request)}};
  `,
        resolveDir: import.meta.dirname,
        sourcefile: 'credential-outbox-runtime-fixture.mjs',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      external: ['cloudflare:sockets'],
    })
    const options = () => ({
      ...convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: '2026-09-17',
        bindings: { AUTH0_DOMAIN: 'fixture.auth0.com' },
        durableObjects: { EMAIL_ALERTS: { className: 'RecoveryFixture', useSQLite: true } },
        name: 'credential-fixture',
      }),
      resourcePersistencePath: dir,
    })
    let mf = new Miniflare(options())
    try {
      const changedAt = Math.floor(Date.now() / 1000) - 3600
      let response = await mf.dispatchFetch('https://test.local/credential-enqueue', {
        method: 'POST',
        body: JSON.stringify({
          issuer: 'https://fixture.auth0.com/',
          subject: 'auth0|synthetic',
          changedAt,
        }),
      })
      assert.equal(response.status, 202)
      assert.deepEqual(await response.json(), { durable: true })
      await mf.dispose()
      mf = new Miniflare(options())
      response = await mf.dispatchFetch('https://test.local/credential-status')
      assert.equal((await response.json()).pending, 1)
      response = await mf.dispatchFetch('https://test.local/test-replay', { method: 'POST' })
      assert.deepEqual(await response.json(), { delivered: changedAt })
      assert.equal(
        (await (await mf.dispatchFetch('https://test.local/credential-status')).json()).pending,
        0,
      )
      response = await mf.dispatchFetch('https://test.local/credential-enqueue', {
        method: 'POST',
        body: JSON.stringify({
          issuer: 'https://fixture.auth0.com/',
          subject: 'auth0|synthetic',
          changedAt: changedAt - 1,
        }),
      })
      assert.equal(response.status, 202)
      assert.equal(
        (await (await mf.dispatchFetch('https://test.local/credential-status')).json()).pending,
        0,
      )
    } finally {
      await mf.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  },
)
