import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'

const { build } = createRequire(
  new URL('../../../cloudflare-gateway/package.json', import.meta.url),
)('esbuild')
await mkdir('workers/upload-cpu/dist/benchmark', { recursive: true })
await build({
  entryPoints: ['workers/upload-cpu/benchmark/run.ts'],
  outfile: 'workers/upload-cpu/dist/benchmark/run.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
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
