import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// An endpoint URL or a successful CLI promotion does not prove the app started.
// This is one preflight check, not a replacement for database/AI isolation checks.
export function assertTestAppReady(rows, manifest) {
  if (!/^STILLMARK_LOADTEST_[A-Z0-9_]+$/.test(manifest.database ?? ''))
    throw Error('Isolated database required')
  if (!Array.isArray(rows) || rows.length !== 1) throw Error('Exactly one app required')
  const row = rows[0]
  const source = JSON.parse(row.source)
  const scope = `${manifest.database}.${manifest.schema}.`
  if (
    row.status !== 'RUNNING' ||
    Number(row.current_instances) !== 1 ||
    row.is_upgrading !== 'false' ||
    row.name !== manifest.name ||
    row.database_name !== manifest.database ||
    row.schema_name !== manifest.schema ||
    row.owner !== `${manifest.database}_PERSONAL_PHOTOS_RUNTIME` ||
    row.auto_resume !== 'false' ||
    Number(row.min_instances) !== 1 ||
    Number(row.max_instances) !== 1 ||
    row.query_warehouse !== manifest.query_warehouse ||
    !manifest.artifact_repo.startsWith(scope) ||
    source.artifactRepository !== manifest.artifact_repo ||
    source.package !== manifest.package_name ||
    !/^VERSION\$\d+$/.test(source.version ?? '')
  )
    throw Error('Test app is not running with the expected isolated deployment')
  const origin = new URL(row.url.startsWith('https://') ? row.url : `https://${row.url}`)
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.snowflakecomputing.app'))
    throw Error('Unexpected app endpoint')
  const configuredOrigin = manifest.environment_variables.find(
    (e) => e.name === 'APP_ORIGIN',
  )?.value
  if (configuredOrigin !== origin.origin) throw Error('Applied APP_ORIGIN must match the endpoint')
  return { appService: scope + row.name, origin: origin.origin, version: source.version }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [descriptionPath, manifestPath] = process.argv.slice(2)
    if (!descriptionPath || !manifestPath)
      throw Error('Usage: app-readiness.mjs DESCRIPTION.json MANIFEST.json')
    if (Date.now() - (await stat(descriptionPath)).mtimeMs > 60000)
      throw Error('Capture a fresh DESCRIBE APPLICATION SERVICE result')
    console.log(
      JSON.stringify(
        assertTestAppReady(
          JSON.parse(await readFile(descriptionPath, 'utf8')),
          JSON.parse(await readFile(manifestPath, 'utf8')),
        ),
      ),
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
