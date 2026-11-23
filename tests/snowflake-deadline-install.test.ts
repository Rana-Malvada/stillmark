import { expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('reproducibly installs the SDK patch and rejects source drift and upgrades', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-deadline-'))
  const install = resolve('scripts/snowflake-deadline/install.cjs')
  const patch = JSON.parse(await readFile('scripts/snowflake-deadline/patch.json', 'utf8'))
  const root = join(dir, 'node_modules/snowflake-sdk')
  try {
    await mkdir(join(root, 'dist/lib/http'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: patch.version }))
    for (const [name, spec] of Object.entries<any>(patch.files)) {
      const installed = await readFile(
        join('node_modules/snowflake-sdk/dist/lib/http', name),
        'utf8',
      )
      await writeFile(join(root, 'dist/lib/http', name), installed.replace(spec.after, spec.before))
    }
    const run = () => promisify(execFile)(process.execPath, [install], { cwd: dir })
    await run()
    await run()
    const file = join(root, 'dist/lib/http/base.js')
    await writeFile(file, (await readFile(file, 'utf8')) + '\n// source drift\n')
    await expect(run()).rejects.toThrow('Unexpected Snowflake SDK source')
    await writeFile(join(root, 'package.json'), '{"version":"3.5.0"}')
    await expect(run()).rejects.toThrow('Review Snowflake deadline patch')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
