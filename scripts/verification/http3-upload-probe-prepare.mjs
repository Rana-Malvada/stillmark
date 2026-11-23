import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLAN_BYTES,
  PROBE_ORIGIN,
  PROBE_WORKER,
  RESTORE_VERSION,
  WINDOW_MS,
} from './http3-upload-probe-plan.mjs'

export function probeConfig(base, runId, start = 0) {
  if (
    base.name !== PROBE_WORKER ||
    base.workers_dev !== true ||
    base.vars?.GATEWAY_ORIGIN !== PROBE_ORIGIN ||
    !/^[a-f0-9]{32}$/.test(base.account_id ?? '')
  )
    throw Error('Expected the existing isolated gateway configuration')
  return {
    name: PROBE_WORKER,
    account_id: base.account_id,
    main: fileURLToPath(new URL('./http3-upload-probe-worker.mjs', import.meta.url)),
    compatibility_date: '2026-09-17',
    compatibility_flags: [],
    workers_dev: true,
    preview_urls: false,
    placement: { mode: 'off' },
    observability: { enabled: false },
    triggers: { crons: [] },
    vars: {
      PROBE_RUN_ID: runId,
      PROBE_START_MS: String(start),
      PROBE_END_MS: String(start ? start + WINDOW_MS : 0),
    },
  }
}

async function main() {
  const [basePath, outputPath, activate] = process.argv.slice(2)
  if (!basePath || !outputPath || (activate && activate !== '--activate'))
    throw Error(
      'Usage: node http3-upload-probe-prepare.mjs BASE_CONFIG PRIVATE_OUTPUT [--activate]',
    )
  const output = resolve(outputPath)
  const roots = ['.release', '.load-tests'].map((path) => resolve(path) + '/')
  if (!roots.some((root) => output.startsWith(root)))
    throw Error('Output must be under private .release/ or .load-tests/')
  const base = JSON.parse(await readFile(basePath, 'utf8'))
  probeConfig(base, randomUUID()) // Validate before writing anything.
  await mkdir(output, { recursive: true, mode: 0o700 })
  const credentialPath = resolve(output, 'credentials.private.json')
  let credentials
  try {
    if ((await stat(credentialPath)).mode & 0o077)
      throw Error('Credential file permissions must be0600')
    credentials = JSON.parse(await readFile(credentialPath, 'utf8'))
    if (
      !/^[a-f0-9]{64}$/.test(credentials.UPLOAD_PROBE_TOKEN ?? '') ||
      !/^[a-f0-9-]{36}$/.test(credentials.runId ?? '')
    )
      throw Error('Invalid private credential file')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    credentials = { runId: randomUUID(), UPLOAD_PROBE_TOKEN: randomBytes(32).toString('hex') }
    await writeFile(credentialPath, JSON.stringify(credentials, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    })
  }
  const start = activate ? Date.now() : 0
  const configPath = resolve(output, 'wrangler.json')
  await writeFile(
    configPath,
    JSON.stringify(probeConfig(base, credentials.runId, start), null, 2) + '\n',
    { mode: 0o600 },
  )
  await writeFile(
    resolve(output, 'restoration.json'),
    JSON.stringify(
      {
        worker: PROBE_WORKER,
        origin: PROBE_ORIGIN,
        restoreVersion: RESTORE_VERSION,
        expectedOriginalSecretBindings: [
          'AUTH0_CLIENT_SECRET',
          'GATEWAY_SIGNING_KEY',
          'SESSION_KEY',
          'SNOWFLAKE_PAT',
        ],
        temporarySecretBinding: 'UPLOAD_PROBE_TOKEN',
        rollbackCommand: ['wrangler', 'rollback', RESTORE_VERSION, '--config', configPath],
        checks: [
          'Confirm original version is still the current baseline before deployment.',
          'Preserve all four original secret values; import only the fresh temporary token via stdin.',
          'After the bounded run, restore the exact version and verify its original variables/bindings.',
          'Verify UPLOAD_PROBE_TOKEN is absent after rollback; remove only this temporary binding if still present.',
        ],
        limits: {
          requests: 20,
          plannedBytes: PLAN_BYTES,
          maximumBytes: 48 * 1024 * 1024,
          windowMs: WINDOW_MS,
        },
        budgetScope:
          'Fixed client plan across both lanes; server replay/count limits are per isolate, not durable global accounting.',
        active: Boolean(start),
        tokenPrinted: false,
        deployed: false,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  console.log(
    JSON.stringify({
      prepared: true,
      active: Boolean(start),
      configPath,
      credentialPath,
      endMs: start ? start + WINDOW_MS : 0,
    }),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Probe preparation failed; no deployment attempted.')
    process.exitCode = 1
  })
