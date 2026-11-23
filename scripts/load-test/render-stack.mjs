#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  isolatedAppManifest,
  isolatedNetworkRulesSql,
  isolatedProfile,
  isolatedWorkerSpec,
} from './isolation-profile.mjs'

const exec = promisify(execFile)
async function main() {
  const [file] = process.argv.slice(2)
  if (!file) throw Error('Usage: render-stack.mjs TARGET.json')
  const target = JSON.parse(await readFile(file, 'utf8'))
  const base = JSON.parse(await readFile('config/deployment.json', 'utf8'))
  const profile = isolatedProfile(base, target)
  const { stdout: revision } = await exec('git', ['rev-parse', 'HEAD'])
  const output = resolve('.load-tests', profile.DATABASE.toLowerCase(), 'source')
  await mkdir(resolve('.load-tests'), { recursive: true, mode: 0o700 })
  await mkdir(resolve('.load-tests', profile.DATABASE.toLowerCase()), { mode: 0o700 })
  await mkdir(output, { mode: 0o700 })
  // Only committed source enters the bundle. Never recursively copy the workspace.
  const archive = join(resolve('.load-tests', profile.DATABASE.toLowerCase()), 'source.tar')
  await exec('git', ['archive', '--format=tar', '--output=' + archive, 'HEAD'])
  await exec('tar', ['-xf', archive, '-C', output])
  await writeFile(join(output, 'config/deployment.json'), JSON.stringify(profile, null, 2) + '\n', {
    mode: 0o600,
  })
  await writeFile(join(output, 'isolated-network-rules.sql'), isolatedNetworkRulesSql(profile), {
    mode: 0o600,
  })
  // JSON is also valid YAML; the Snowflake CLI reads this as app.yml.
  await writeFile(
    join(output, 'app.yml'),
    JSON.stringify(isolatedAppManifest(profile), null, 2) + '\n',
    { mode: 0o600 },
  )
  const image = `/${profile.DATABASE.toLowerCase()}/app/${profile.IMAGE_REPOSITORY.toLowerCase()}/upload-worker:baseline-${revision.trim().slice(0, 12)}`
  await writeFile(
    join(output, 'workers/upload-cpu/isolated-spec.json'),
    JSON.stringify(isolatedWorkerSpec(profile, image), null, 2) + '\n',
    { mode: 0o600 },
  )
  await writeFile(
    join(output, 'ISOLATED-BUILD.json'),
    JSON.stringify(
      {
        revision: revision.trim(),
        database: profile.DATABASE,
        pgDatabase: profile.PG_DATABASE,
        image,
        productionDeployment: false,
        provisioned: false,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  console.log(
    JSON.stringify({ output, revision: revision.trim(), image, provisioned: false }, null, 2),
  )
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
