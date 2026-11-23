/** Synthetic local decode profile. No user photos, providers or app traffic. */
import sharp from 'sharp'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

if (process.argv[2] === '--child') {
  const mode = process.argv[3]
  if (!['parallel', 'serial'].includes(mode)) throw Error('Invalid profile mode')
  const input = readFileSync(process.argv[4])
  const started = performance.now()
  const render = async (size, quality) =>
    sharp(input, { limitInputPixels: 80_000_000 })
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer()
  const outputs =
    mode === 'parallel'
      ? await Promise.all([render(2400, 85), render(400, 80)])
      : [await render(2400, 85), await render(400, 80)]
  console.log(
    JSON.stringify({
      mode,
      elapsedMs: Math.round(performance.now() - started),
      peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      inputMiB: Math.round((input.length / 1048576) * 100) / 100,
      outputBytes: outputs.map((b) => b.length),
      hashes: outputs.map((b) => createHash('sha256').update(b).digest('hex')),
    }),
  )
} else {
  const directory = mkdtempSync(join(tmpdir(), 'stillmark-decode-'))
  try {
    const cases = [
      [4000, 3000],
      [8000, 6000],
      [10000, 8000],
    ]
    for (const [width, height] of cases) {
      // Structured gradients and sharp edges give the codecs real spatial work
      // without capturing private content or retaining a large fixture in Git.
      const input = Buffer.alloc(width * height * 3)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 3
          input[i] = (x * 13 + y * 7) % 256
          input[i + 1] = (x ^ y) % 256
          input[i + 2] = (((x >> 4) + (y >> 4)) * 37) % 256
        }
      for (const format of ['jpeg', 'tiff']) {
        const path = join(directory, `${width}-${format}`)
        await sharp(input, { raw: { width, height, channels: 3 } })
          .toFormat(format)
          .toFile(path)
        const results = []
        for (let iteration = 0; iteration < 3; iteration++) {
          for (const mode of iteration % 2 ? ['serial', 'parallel'] : ['parallel', 'serial']) {
            const run = spawnSync(
              process.execPath,
              [fileURLToPath(import.meta.url), '--child', mode, path],
              { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 },
            )
            if (run.status !== 0) throw Error(run.stderr || run.error?.message || 'Profile failed')
            results.push(JSON.parse(run.stdout))
          }
        }
        if (results.some((r) => JSON.stringify(results[0].hashes) !== JSON.stringify(r.hashes)))
          throw Error('Schedule changed output bytes')
        console.log(
          JSON.stringify({
            width,
            height,
            format,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            vips: sharp.versions.vips,
            sourceSha256: createHash('sha256')
              .update(
                readFileSync(new URL('../../lib/upload/upload-processing.ts', import.meta.url)),
              )
              .digest('hex'),
            results: ['parallel', 'serial'].map((mode) => {
              const runs = results.filter((r) => r.mode === mode)
              const times = runs.map((r) => r.elapsedMs).sort((a, b) => a - b)
              const memory = runs.map((r) => r.peakRssMiB).sort((a, b) => a - b)
              return {
                mode,
                samples: runs.length,
                elapsedMedianMs: times[1],
                elapsedRangeMs: [times[0], times[2]],
                peakRssMedianMiB: memory[1],
                peakRssMaxMiB: memory[2],
                outputBytes: runs[0].outputBytes,
                identicalOutput: true,
              }
            }),
          }),
        )
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
