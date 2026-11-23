import test from 'node:test'
import assert from 'node:assert/strict'
import { assertTestAppReady } from './app-readiness.mjs'

const database = 'STILLMARK_LOADTEST_BASELINE'
const manifest = {
  database,
  schema: 'APP',
  name: 'UPLOAD_HTTP_TEST',
  query_warehouse: database + '_WH',
  artifact_repo: database + '.APP.UPLOAD_HTTP_REPO',
  package_name: 'UPLOAD_HTTP',
  environment_variables: [{ name: 'APP_ORIGIN', value: 'https://test.snowflakecomputing.app' }],
}
const row = {
  name: manifest.name,
  database_name: database,
  schema_name: 'APP',
  status: 'RUNNING',
  current_instances: 1,
  min_instances: 1,
  max_instances: 1,
  is_upgrading: 'false',
  auto_resume: 'false',
  owner: database + '_PERSONAL_PHOTOS_RUNTIME',
  query_warehouse: manifest.query_warehouse,
  url: 'test.snowflakecomputing.app',
  source: JSON.stringify({
    artifactRepository: manifest.artifact_repo,
    package: manifest.package_name,
    version: 'VERSION$2',
  }),
}
test('startup requires running instance, not merely a published endpoint', () => {
  assert.equal(assertTestAppReady([row], manifest).version, 'VERSION$2')
  for (const status of ['FAILED', 'SUSPENDED', 'SUSPENDING', 'PENDING'])
    assert.throws(() => assertTestAppReady([{ ...row, status }], manifest))
  assert.throws(() => assertTestAppReady([{ ...row, current_instances: 0 }], manifest))
})
test('startup rejects wrong runtime role, package, origin or database', () => {
  for (const patch of [
    { owner: 'ACCOUNTADMIN' },
    { database_name: 'PERSONAL_MEDIA' },
    { is_upgrading: 'true' },
    { auto_resume: 'true' },
    { url: 'other.snowflakecomputing.app' },
    {
      source: JSON.stringify({
        artifactRepository: 'PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_REPO',
        package: 'UPLOAD_HTTP',
        version: 'VERSION$2',
      }),
    },
  ])
    assert.throws(() => assertTestAppReady([{ ...row, ...patch }], manifest))
})
