#!/usr/bin/env node
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream, writeSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { planRun, runLoad } from './harness.mjs'

// Credentials and results stay outside version control; no request bodies are logged.
async function main() {
  const args = process.argv.slice(2)
  if (!args[0] || args.slice(1).some((x) => x !== '--execute'))
    throw Error('Usage: node scripts/load-test/run.mjs CONFIG.json [--execute]')
  const configPath = resolve(args[0])
  const root = dirname(configPath)
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const actorPath = resolve(root, config.actorsFile)
  const permissions = await stat(actorPath)
  if (permissions.mode & 0o077) throw Error('Actor credentials file must have permissions 0600')
  const actors = JSON.parse(await readFile(actorPath, 'utf8'))
  const fixtures = []
  for (const entry of config.fixtures) {
    const path = resolve(root, entry.path)
    const info = await stat(path)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    const sha256 = hash.digest('hex')
    if (sha256 !== entry.sha256) throw Error('Fixture hash mismatch')
    fixtures.push({
      name: basename(path),
      size: info.size,
      sha256,
      readChunk: async (start, end) => {
        const file = await open(path, 'r')
        try {
          const buffer = Buffer.alloc(end - start)
          let offset = 0
          while (offset < buffer.length) {
            const { bytesRead } = await file.read(
              buffer,
              offset,
              buffer.length - offset,
              start + offset,
            )
            if (!bytesRead) break
            offset += bytesRead
          }
          return buffer.subarray(0, offset)
        } finally {
          await file.close()
        }
      },
    })
  }
  const plan = planRun(config, actors, fixtures)
  console.log(
    JSON.stringify({ mode: args.includes('--execute') ? 'execute' : 'dry-run', plan }, null, 2),
  )
  if (!args.includes('--execute')) return
  const key = process.env.LOAD_TEST_ATTESTATION_KEY
  if (!key || Buffer.byteLength(key) < 32)
    throw Error('LOAD_TEST_ATTESTATION_KEY must contain at least 32 bytes')
  let attestationEnvelope
  if (config.attestationFile) {
    const path = resolve(root, config.attestationFile)
    if ((await stat(path)).mode & 0o077) throw Error('Attestation file must be private')
    attestationEnvelope = JSON.parse(await readFile(path, 'utf8'))
  }
  const output = resolve('.load-tests', config.runId)
  await mkdir(resolve('.load-tests'), { recursive: true, mode: 0o700 })
  await mkdir(output, { mode: 0o700 }) // Never overwrite a prior run.
  const journal = await open(resolve(output, 'events.jsonl'), 'wx', 0o600)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const summary = await runLoad(config, actors, fixtures, {
      key,
      attestationEnvelope,
      signal: controller.signal,
      emit: (event) => {
        // Synchronous local journaling bounds memory; disk failure stops the run.
        try {
          writeSync(journal.fd, JSON.stringify(event) + '\n')
        } catch (error) {
          stop()
          throw error
        }
      },
    })
    await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2), {
      mode: 0o600,
      flag: 'wx',
    })
    console.log(
      JSON.stringify({
        passed: summary.passed,
        completed: summary.completed,
        planned: plan.files,
        output,
      }),
    )
    if (!summary.passed) process.exitCode = 1
  } finally {
    await journal.close()
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
main().catch(() => {
  console.error(
    'Load test failed. Check configuration, isolation attestation, credentials, and private run journal.',
  )
  process.exitCode = 1
})
