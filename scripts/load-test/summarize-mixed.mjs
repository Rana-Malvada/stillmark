import { readFile, writeFile } from 'node:fs/promises'
import { assessMixed, generatorCpuWindows } from './mixed-gates.mjs'

// Offline analysis only. Inputs are private evidence paths, never credentials.
export function summarizeMixed(result, database, durable) {
  const gate = assessMixed(result, database)
  const s = result.summary ?? {}
  const complete = [durable.jobs, durable.done, durable.distinctUploads, durable.photos]
  const durablePass =
    complete.every((n) => Number.isSafeInteger(n) && n === s.completed) &&
    durable.aiRestRequests === 0
  const backlog = database.map((x) => x.queued + x.processing).filter(Number.isFinite)
  const samples = result.samples ?? []
  const cpuWindows = gate.reasons.includes('missing_generator_samples')
    ? []
    : generatorCpuWindows(samples).filter(Number.isFinite)
  return {
    passed: gate.passed && durablePass,
    reasons: [...gate.reasons, ...(!durablePass ? ['durable_reconciliation'] : [])],
    functionalPass: s.passed === true,
    sustainedOverlap: s.uploadCoveredMeasurement === true,
    measuredRequests: s.measuredRequests,
    measuredRequestsPerSecond: s.capacityEligible
      ? s.measuredRequests / s.measurementSeconds
      : null,
    completedUploads: s.completed,
    measuredSeconds: s.measurementSeconds,
    totalWallSeconds: result.wallMs / 1000,
    maxDatabaseConnections: Math.max(...database.map((x) => x.connections)),
    peakUploadBacklog: Math.max(...backlog),
    finalUploadBacklog: backlog.at(-1),
    maxOldestUploadAgeSeconds: Math.max(...database.map((x) => x.oldestUploadAgeSeconds)),
    maxGeneratorCpuFraction: cpuWindows.length ? Math.max(...cpuWindows) : null,
    maxGeneratorRssBytes: samples.length ? Math.max(...samples.map((x) => x.memory.rss)) : null,
    operations: Object.fromEntries(
      Object.entries(s.operations ?? {}).filter(([k]) => k.startsWith('measured:')),
    ),
    limits: gate.limits,
  }
}
if (process.argv[1]?.endsWith('/summarize-mixed.mjs')) {
  const [directory] = process.argv.slice(2)
  if (!directory) throw Error('Usage: summarize-mixed.mjs PRIVATE_RUN_DIRECTORY')
  const read = async (name) => JSON.parse(await readFile(directory + '/' + name, 'utf8'))
  const result = summarizeMixed(
    await read('cloud-result.json'),
    await read('db-samples.json'),
    await read('durable.json'),
  )
  await writeFile(directory + '/assessment.json', JSON.stringify(result, null, 2) + '\n')
  console.log(
    JSON.stringify({
      passed: result.passed,
      reasons: result.reasons,
      completedUploads: result.completedUploads,
      maxDatabaseConnections: result.maxDatabaseConnections,
      peakUploadBacklog: result.peakUploadBacklog,
      measuredRequestsPerSecond: result.measuredRequestsPerSecond,
    }),
  )
}
