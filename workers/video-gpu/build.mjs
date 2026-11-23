import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workerDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(workerDir, '../..')
const sourceCommit = process.env.SOURCE_COMMIT || null
if (sourceCommit && !/^[a-f0-9]{40}$/.test(sourceCommit)) throw Error('Invalid source commit')
// The standalone GPU worker uses its own restricted role, not web-request identity.
const result = await build({
  absWorkingDir: root,
  metafile: true,
  entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: fileURLToPath(new URL('./dist/worker.mjs', import.meta.url)),
  plugins: [
    {
      name: 'worker-database',
      setup(b) {
        b.onResolve({ filter: /(^|\/)postgres$/ }, () => ({
          path: fileURLToPath(new URL('./postgres.mjs', import.meta.url)),
        }))
      },
    },
  ],
})

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const inputs = [
  ...new Set([
    ...Object.keys(result.metafile.inputs),
    'workers/video-gpu/build.mjs',
    'workers/video-gpu/package.json',
    'workers/video-gpu/package-lock.json',
  ]),
].sort()
const sourceHashes = Object.fromEntries(
  await Promise.all(
    inputs.map(async (path) => [
      relative(root, resolve(root, path)),
      sha256(await readFile(resolve(root, path))),
    ]),
  ),
)
await writeFile(
  new URL('./dist/build-info.json', import.meta.url),
  JSON.stringify(
    {
      sourceCommit,
      sourceHashes,
      bundleSha256: sha256(await readFile(new URL('./dist/worker.mjs', import.meta.url))),
    },
    null,
    2,
  ) + '\n',
)
