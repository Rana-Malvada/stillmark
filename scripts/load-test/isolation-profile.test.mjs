import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  isolatedAppManifest,
  isolatedNetworkRulesSql,
  isolatedProfile,
  isolatedWorkerSpec,
} from './isolation-profile.mjs'

const base = JSON.parse(
  await readFile(new URL('../../config/deployment.json', import.meta.url), 'utf8'),
)
const target = {
  suffix: 'BASELINE',
  pgHost: 'isolated-test.account.region.aws.postgres.snowflake.app',
  appOrigin: 'https://isolated-test.snowflakecomputing.app',
}
test('isolated build binds new catalog, storage, roles and Postgres', () => {
  const p = isolatedProfile(base, target)
  assert.equal(p.DATABASE, 'STILLMARK_LOADTEST_BASELINE')
  assert.equal(p.PG_DATABASE, 'stillmark_loadtest_baseline')
  assert.notEqual(p.GATEWAY_USER, base.GATEWAY_USER)
  assert.notEqual(p.RESOURCE_PERSONAL_PHOTOS_RUNTIME, base.RESOURCE_PERSONAL_PHOTOS_RUNTIME)
  assert.notEqual(p.WAREHOUSE, base.WAREHOUSE)
  assert.equal(p.AUTH0_CLIENT_ID, 'disabled')
  assert.equal(base.DATABASE, 'PERSONAL_MEDIA')
  for (const key of Object.keys(p).filter((k) => k.startsWith('RESOURCE_')))
    assert.ok(p[key].startsWith('STILLMARK_LOADTEST_'))
})
test('production endpoints and malformed names are refused', () => {
  for (const patch of [
    { pgHost: base.PG_HOST },
    { appOrigin: base.APP_ORIGIN },
    { suffix: 'BAD;SQL' },
    { appOrigin: 'https://example.test' },
    { pgHost: 'example.test' },
  ])
    assert.throws(() => isolatedProfile(base, { ...target, ...patch }))
})
test('manifest disables background work and excludes private load artifacts', () => {
  const p = isolatedProfile(base, target)
  const m = isolatedAppManifest(p)
  const env = Object.fromEntries(m.environment_variables.map((x) => [x.name, x.value]))
  assert.equal(m.auto_suspend_secs, 300)
  assert.equal(m.auto_resume, false)
  assert.equal(m.execute_as_role, undefined)
  assert.equal(env.SF_TELEMETRY_DISABLE_CONNECTION_SHAPE, 'true')
  assert.equal(env.BACKGROUND_JOBS_ENABLED, 'false')
  assert.equal(env.UPLOAD_PROCESSING_WORKER_ENABLED, 'false')
  assert.equal(env.UPLOAD_ROUTING_MANAGED, 'false')
  assert.ok(m.ignore.includes('.load-tests'))
  assert.ok(m.secrets.every((x) => x.secret.startsWith(p.DATABASE + '.APP.')))
  assert.ok(m.secrets.every((x) => !x.name.includes('MAINTENANCE') && !x.name.includes('AUTH0')))
  assert.ok(!JSON.stringify(m).includes('PERSONAL_MEDIA.'))
})
test('worker cannot reuse a production image compiled with production storage names', () => {
  const p = isolatedProfile(base, target)
  assert.throws(() =>
    isolatedWorkerSpec(p, '/personal_media/app/photos_repo/upload-worker:queued-v8'),
  )
  const spec = isolatedWorkerSpec(
    p,
    '/stillmark_loadtest_baseline/app/photos_repo/upload-worker:baseline-test',
  )
  assert.equal(spec.spec.containers[0].env.PG_DATABASE, p.PG_DATABASE)
  assert.equal(spec.spec.endpoints[0].public, false)
  assert.equal(spec.spec.containers[0].env.UPLOAD_COMPLETIONS_PER_INSTANCE, '2')
})
test('production bundle template and generated manifest exclude load-test private directory', async () => {
  for (const file of ['app.yml', 'config/templates/app.yml'])
    assert.match(await readFile(file, 'utf8'), /^  - \.load-tests$/m)
})

test('external rules exclude the managed artifact access point that broke startup', () => {
  const p = isolatedProfile(base, target)
  const sql = isolatedNetworkRulesSql(p)
  assert.ok(sql.includes(p.PG_HOST + ':5432'))
  assert.ok(sql.includes(p.STORAGE_HOST + ':443'))
  assert.ok(!sql.includes(p.RUNTIME_STORAGE_HOST))
  assert.throws(() => isolatedNetworkRulesSql(base))
  assert.throws(() => isolatedNetworkRulesSql({ ...p, STORAGE_HOST: p.RUNTIME_STORAGE_HOST }))
})
