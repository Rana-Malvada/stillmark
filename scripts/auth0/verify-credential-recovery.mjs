/** Actual Action + gateway handlers + native PostgreSQL; synthetic identities, no external fetch. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import { withLocalPostgres } from '../verification/local-postgres.mjs'
import { credentialEvent } from '../../cloudflare-gateway/customer-accounts.mjs'
import { credentialLog } from '../../cloudflare-gateway/credential-log.mjs'
import { CredentialOutbox } from '../../cloudflare-gateway/credential-outbox.mjs'
import { identityAssertion } from '../../cloudflare-gateway/proxy.mjs'
import { credentialReplay } from './replay-credential-change.mjs'

const root = new URL('../../', import.meta.url)
const source = readFileSync(new URL('./credential-change-action.cjs', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('lib/identity/gateway-assertion.ts', root))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  packages: 'external',
})
const { verifyGatewayAssertion } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
)
const env = {
  GATEWAY_ORIGIN: 'https://fixture.example',
  SNOWFLAKE_ORIGIN: 'https://fixture.snowflakecomputing.app',
  SNOWFLAKE_PAT: 'synthetic-transport-token',
  AUTH0_DOMAIN: 'fixture.auth0.invalid',
  GATEWAY_SIGNING_KEY: '71'.repeat(32),
  AUTH0_EVENT_KEY: '72'.repeat(32),
  CUSTOMER_ACCOUNTS_ENABLED: 'true',
}
const issuer = `https://${env.AUTH0_DOMAIN}/`

await withLocalPostgres('credential-recovery', async ({ admin, connect, imageId }) => {
  await admin.query(
    'CREATE ROLE snowflake_admin; CREATE ROLE personal_photos_app NOINHERIT; CREATE ROLE personal_photos_reader; CREATE ROLE personal_photos_video_worker; CREATE ROLE personal_photos_maintenance;',
  )
  await admin.query(readFileSync(new URL('tests/fixtures/rls-schema.sql', root), 'utf8'))
  await admin.query(
    'SET search_path=public; GRANT USAGE ON SCHEMA public TO personal_photos_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO personal_photos_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO personal_photos_app;',
  )
  for (const path of ['setup/71-catalog-read-rls.sql', 'setup/72-app-rls.sql'])
    await admin.query(readFileSync(new URL(path, root), 'utf8'))
  for (const path of [
    '202610062030_gateway_security.sql',
    '202610280100_app_permissions.sql',
    '202610280130_gateway_cleanup_index_cutoff.sql',
    '202610251400_album_permission_queries.sql',
    '202610301200_customer_registration.sql',
  ]) {
    await admin.query('BEGIN')
    await admin.query(readFileSync(new URL(`migrations/postgres/${path}`, root), 'utf8'))
    await admin.query('COMMIT')
  }
  for (const user of ['alice', 'bob']) {
    const marker = randomUUID()
    await admin.query(
      "INSERT INTO gallery_access_objects(kind,name,marker,display_name,created_by,state,auth0_user_id) VALUES('user',$1,$2,$1,'fixture','ready',$3)",
      [user.toUpperCase(), marker, 'auth0|fixture-' + user],
    )
    await admin.query('INSERT INTO photo_security.app_principals(marker) VALUES($1)', [marker])
    await admin.query(
      "INSERT INTO photo_security.app_memberships(marker,role_key) VALUES($1,'member')",
      [marker],
    )
  }
  const app = await connect('personal_photos_app')
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const cutoff = Math.floor(originalNow() / 1000) - 120
  const subject = 'auth0|fixture-alice'
  const captured = []
  const upstreamClaims = []
  let outage = true
  let loseAcknowledgement = false
  globalThis.fetch = async (input, options) => {
    const request = input instanceof Request ? input : new Request(input, options)
    const url = new URL(request.url)
    if (url.origin === env.GATEWAY_ORIGIN && url.pathname === '/auth/credential-change')
      return credentialEvent(request, env)
    // Every possible network destination is intercepted or rejected. No credential
    // reaches Snowflake/Auth0/email, including if a handler's destination changes.
    assert.equal(url.origin, env.SNOWFLAKE_ORIGIN, 'Unexpected outbound origin')
    assert.equal(url.pathname, '/api/account/credential-change', 'Unexpected outbound route')
    const claims = verifyGatewayAssertion(
      request.headers.get('x-photo-gateway-identity'),
      env.GATEWAY_SIGNING_KEY,
      env.GATEWAY_ORIGIN,
    )
    assert.equal(claims.method, 'POST')
    assert.equal(claims.target, '/api/account/credential-change')
    assert.equal(claims.sub, subject)
    upstreamClaims.push(claims)
    if (outage) return new Response('Synthetic database unavailable', { status: 503 })
    await app.query('SELECT photo_security.record_credential_change($1,$2)', [
      claims.sub,
      claims.credentialChange,
    ])
    if (loseAcknowledgement) {
      loseAcknowledgement = false
      throw new TypeError('Synthetic response lost after commit')
    }
    return Response.json({ ok: true })
  }
  async function access(who, startedAt, path = '/api/account') {
    const token = await identityAssertion(
      { auth0Subject: who, sid: randomUUID(), startedAt },
      env,
      new Request(env.GATEWAY_ORIGIN + path),
    )
    const claims = verifyGatewayAssertion(token, env.GATEWAY_SIGNING_KEY, env.GATEWAY_ORIGIN)
    const result = await app.query(
      'SELECT * FROM photo_security.gateway_customer_identity_once($1,$2,$3,$4,$5)',
      [claims.sub, claims.sid, claims.jti, claims.exp, claims.startedAt ?? null],
    )
    const identity = result.rows[0]
    return identity && !identity.revoked && identity.enabled && identity.app_role ? 200 : 401
  }
  try {
    const exported = {}
    vm.runInNewContext(source, {
      exports: exported,
      require,
      URL,
      Buffer,
      AbortSignal,
      Date: { now: () => cutoff * 1000 },
      fetch: globalThis.fetch,
      console: { error: (message) => captured.push(JSON.parse(message)) },
    })
    // Run the outage at its original time, then recover two minutes later. Native
    // PostgreSQL keeps its real clock; the cutoff remains in the past throughout.
    Date.now = () => cutoff * 1000
    await assert.rejects(
      exported.onExecutePostChangePassword({
        user: { user_id: subject, password: 'synthetic-never-log-password' },
        secrets: {
          STILLMARK_ORIGIN: env.GATEWAY_ORIGIN,
          STILLMARK_ISSUER: issuer,
          STILLMARK_EVENT_KEY: env.AUTH0_EVENT_KEY,
        },
      }),
      /not acknowledged/,
    )
    Date.now = originalNow
    assert.equal(upstreamClaims.length, 3)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].changedAt, cutoff)
    const diagnostic = JSON.stringify(captured[0])
    for (const secret of [
      env.SNOWFLAKE_PAT,
      env.AUTH0_EVENT_KEY,
      env.GATEWAY_SIGNING_KEY,
      'synthetic-never-log-password',
    ])
      assert.equal(diagnostic.includes(secret), false)
    assert.equal(
      await access(subject, cutoff - 1),
      200,
      'Failed delivery must not falsely claim revocation was persisted',
    )
    console.log(
      'PASS local outage: 3 attempts, one structured failure captured; revocation pending until persistence',
    )
    // Synthetic alert sink only. The receipt fingerprint links the actionable
    // original-cutoff record to an operator runbook without logging its subject.
    const alert = {
      severity: 'critical',
      code: captured[0].event,
      receiptSha256: createHash('sha256').update(diagnostic).digest('hex'),
      originalCutoff: cutoff,
      attempts: captured[0].attempts,
      runbook: 'docs/CUSTOMER-ACCOUNTS.md#durable-credential-recovery-and-failure-alerts',
    }
    assert.equal(alert.attempts, 3)
    assert.equal(alert.originalCutoff, captured[0].changedAt)
    assert.ok(alert.runbook)
    console.log(
      'PASS local captured alert: original cutoff, receipt correlation, attempt count and recovery runbook',
    )

    const replay = () =>
      credentialReplay(captured[0], {
        origin: env.GATEWAY_ORIGIN,
        issuer,
        key: env.AUTH0_EVENT_KEY,
      }).request
    outage = false
    loseAcknowledgement = true
    assert.equal(
      (await fetch(replay())).status,
      503,
      'Lost upstream acknowledgement remains a failed/unknown delivery',
    )
    assert.equal((await fetch(replay())).status, 200)
    assert.equal(upstreamClaims.at(-1).credentialChange, cutoff)
    assert.ok(upstreamClaims.at(-1).startedAt > cutoff)
    for (const path of ['/api/account', '/api/images?path=synthetic', '/api/upload/sessions'])
      assert.equal(await access(subject, cutoff - 1, path), 401)
    assert.equal(await access(subject, cutoff), 401)
    assert.equal(await access(subject, undefined), 401)
    assert.equal(
      await access(subject, cutoff + 1),
      200,
      'A login after the original cutoff but before replay must survive',
    )
    assert.equal(await access('auth0|fixture-bob', cutoff - 1), 200)
    console.log(
      'PASS native Postgres: old/same-second/missing-start sessions denied; post-cutoff login and another user remain valid',
    )
    await app.query('SELECT photo_security.record_credential_change($1,$2)', [subject, cutoff - 30])
    assert.equal(
      Number(
        (
          await admin.query(
            'SELECT cutoff FROM photo_security.credential_cutoffs WHERE subject=$1',
            [subject],
          )
        ).rows[0].cutoff,
      ),
      cutoff,
    )
    assert.equal((await fetch(replay())).status, 200)
    assert.equal(await access(subject, cutoff + 1), 200)
    console.log(
      'PASS native Postgres: duplicate and older deliveries cannot lower cutoff; replay after lost acknowledgement is idempotent',
    )
    const forged = replay()
    forged.headers.set('x-stillmark-signature', '00'.repeat(32))
    assert.equal((await fetch(forged)).status, 401)
    const stale = credentialReplay(captured[0], {
      origin: env.GATEWAY_ORIGIN,
      issuer,
      key: env.AUTH0_EVENT_KEY,
      now: cutoff,
    }).request
    assert.equal((await fetch(stale)).status, 401)
    await assert.rejects(
      app.query('SELECT cutoff FROM photo_security.credential_cutoffs'),
      /permission denied/,
    )
    console.log(
      'PASS forgery/stale transport rejected; application role cannot read protected cutoff table',
    )
    // The live alarm implementation persists to native PostgreSQL through the
    // same signed gateway path. SQLite durability/restart is checked separately
    // in credential-outbox-runtime.test.mjs under workerd.
    const stored = new Map()
    let alarm = null
    const storage = {
      get: async (key) => structuredClone(stored.get(key)),
      put: async (key, value) => stored.set(key, structuredClone(value)),
      delete: async (key) => stored.delete(key),
      list: async ({ prefix, limit }) =>
        new Map([...stored].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
      getAlarm: async () => alarm,
      setAlarm: async (value) => {
        alarm = value
      },
    }
    storage.transaction = (fn) => fn(storage)
    const outbox = new CredentialOutbox({ storage }, env)
    const queueEnv = {
      ...env,
      AUTH0_LOG_STREAM_TOKEN: '75'.repeat(32),
      EMAIL_ALERTS: {
        idFromName: (name) => name,
        get: () => ({ fetch: async (_url, init) => outbox.enqueue(JSON.parse(init.body)) }),
      },
    }
    outage = true
    const newCutoff = cutoff + 30
    const logRequest = () =>
      new Request(env.GATEWAY_ORIGIN + '/auth/credential-log', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + queueEnv.AUTH0_LOG_STREAM_TOKEN },
        body: JSON.stringify([
          {
            log_id: 'synthetic-only',
            data: {
              type: 'scp',
              date: new Date(newCutoff * 1000 + 999).toISOString(),
              user_id: subject,
            },
          },
        ]),
      })
    assert.equal((await credentialLog(logRequest(), queueEnv)).status, 202)
    await outbox.alarm()
    assert.equal((await outbox.status()).pending, 1)
    outage = false
    for (const [key, event] of stored)
      if (key.startsWith('pending:')) await storage.put(key, { ...event, nextAttempt: 0 })
    await new CredentialOutbox({ storage }, env).alarm()
    assert.equal((await outbox.status()).pending, 0)
    assert.equal(await access(subject, newCutoff), 401)
    assert.equal(await access(subject, newCutoff + 1), 200)
    assert.equal(await access('auth0|fixture-bob', cutoff - 1), 200)
    assert.equal((await credentialLog(logRequest(), queueEnv)).status, 202)
    assert.equal((await outbox.status()).pending, 0)
    assert.equal(await access(subject, newCutoff + 1), 200)
    console.log(
      'PASS native PostgreSQL unattended scp recovery: retained during outage, alarm persists original cutoff, later login and other account survive, duplicate does not requeue',
    )
    console.log(
      JSON.stringify({
        scope: 'local-only',
        postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
        imageId,
        actionSha256: createHash('sha256').update(source).digest('hex'),
        operationalAlertDelivery: 'unverified',
      }),
    )
  } finally {
    globalThis.fetch = originalFetch
    Date.now = originalNow
  }
})
