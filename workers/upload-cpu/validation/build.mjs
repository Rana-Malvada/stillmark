import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const { build } = createRequire(root + 'cloudflare-gateway/package.json')('esbuild')
await mkdir('workers/upload-cpu/dist/validation', { recursive: true })
await build({
  entryPoints: [fileURLToPath(new URL('./run.ts', import.meta.url))],
  outfile: 'workers/upload-cpu/dist/validation/run.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  absWorkingDir: root,
  nodePaths: [root + 'node_modules'],
  external: ['pg', 'react', 'sharp', 'snowflake-sdk'],
  plugins: [
    {
      name: 'non-request-job',
      setup(b) {
        b.onResolve({ filter: /^(next\/headers|ffmpeg-static|ffprobe-static)$/ }, (args) => ({
          path: args.path,
          namespace: 'job',
        }))
        b.onLoad({ filter: /.*/, namespace: 'job' }, (args) => ({
          contents:
            args.path === 'next/headers'
              ? `export function headers(){throw Error('HTTP context unavailable in benchmark job')} export const cookies=headers;`
              : args.path === 'ffmpeg-static'
                ? `export default '/app/bin/ffmpeg'`
                : `export default {path:'/app/bin/ffprobe'}`,
          loader: 'js',
        }))
      },
    },
  ],
})
