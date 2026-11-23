import { readFileSync } from 'node:fs'

const payload = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const lines = payload
  .flat(Infinity)
  .flatMap((row) => Object.values(row))
  .join('\n')
  .split('\n')
const records = lines
  .filter((l) => l.startsWith('UPLOAD_BENCH '))
  .map((l) => JSON.parse(l.slice(13)))
const trials = records.filter((r) => r.type === 'trial')
const percentile = (values, p) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1]
console.log(
  JSON.stringify(
    {
      sample: records.find((r) => r.type === 'sample'),
      errors: records.filter((r) => /error/i.test(r.type)),
      cleanup: records.find((r) => r.type === 'cleanup'),
      summary: [1, 2, 4].map((concurrency) => {
        const runs = trials.filter((r) => r.concurrency === concurrency)
        const files = runs.flatMap((r) => r.results)
        const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
        return {
          concurrency,
          trials: runs.length,
          files: files.length,
          filesPerMinute: (files.length * 60000) / runs.reduce((s, r) => s + r.elapsedMs, 0),
          p50Ms: percentile(
            files.map((f) => f.totalMs),
            0.5,
          ),
          p95Ms: percentile(
            files.map((f) => f.totalMs),
            0.95,
          ),
          peakRssMiB: Math.max(...runs.map((r) => r.peakRss)) / 1024 ** 2,
          eventLoopP99Ms: Math.max(...runs.map((r) => r.eventLoopP99Ms)),
          cpuCoreUtilization: mean(
            runs.map((r) => (r.cpu.user + r.cpu.system) / (r.elapsedMs * 1000)),
          ),
          meanStagesMs: Object.fromEntries(
            [...new Set(files.flatMap((f) => Object.keys(f.timings)))].map((k) => [
              k,
              mean(files.map((f) => f.timings[k] ?? 0)),
            ]),
          ),
          trialRates: runs.map((r) => r.filesPerMinute),
          cgroupDeltas: runs.map((r) => r.cgroupDelta),
        }
      }),
    },
    null,
    2,
  ),
)
