// This is a functional/latency gate, not certification of a user count. The
// operator must also verify fixed resource placement and durable queue outcomes.
export const defaultGates = Object.freeze({
  apiP95Ms: 1000,
  apiP99Ms: 2000,
  imageP95Ms: 2000,
  imageP99Ms: 4000,
  generatorWaitP95Ms: 50,
  minSamplesPerOperation: 20,
  maxDatabaseConnections: 400,
  maxUploadBacklog: 1000,
  maxOldestUploadAgeSeconds: 180,
  maxSamplingGapMs: 10000,
  maxGeneratorCpuFraction: 0.8,
  maxGeneratorRssBytes: 4 * 1024 ** 3,
})

// Cumulative counters are sampled, not a CPU trace. Interpolate the start of
// each rolling ten-second window; never average a fixed number of samples.
export function generatorCpuWindows(samples) {
  if (!Array.isArray(samples)) return []
  const total = (sample) => sample.cpu.user + sample.cpu.system
  const windows = []
  let left = 0
  for (let i = 1; i < samples.length; i++) {
    const end = samples[i]
    const start = end.at - 10000
    if (start < samples[0].at) continue
    while (left + 1 < i && samples[left + 1].at <= start) left++
    const a = samples[left]
    const b = samples[left + 1]
    const fraction = (start - a.at) / (b.at - a.at)
    const before = total(a) + (total(b) - total(a)) * fraction
    windows.push((total(end) - before) / 10000000)
  }
  return windows
}
// Resource allocation comes from the verified service specification, not the workload result.
export function assessMixed(result, database, limits = defaultGates, resources = { cpuCores: 1 }) {
  const reasons = []
  const cpuCores = resources?.cpuCores
  if (!Number.isFinite(cpuCores) || cpuCores <= 0 || cpuCores > 64)
    reasons.push('invalid_generator_allocation')
  const s = result.summary
  const started = Date.parse(s?.measurementStartedAt)
  const ended = Date.parse(s?.measurementEndsAt)
  const validWindow = Number.isFinite(started) && Number.isFinite(ended) && ended > started
  if (!validWindow) reasons.push('invalid_measurement_window')
  const coversWindow = (times) =>
    validWindow &&
    times.length >= 2 &&
    times[0] <= started &&
    times.at(-1) >= ended &&
    times.every(
      (at, i) =>
        Number.isFinite(at) &&
        (i === 0 || (at > times[i - 1] && at - times[i - 1] <= limits.maxSamplingGapMs)),
    )
  if (!s?.passed) reasons.push('functional_failure')
  if (!s?.capacityEligible) reasons.push('insufficient_measured_overlap')
  if (s?.upload?.rounds?.some((r) => r.requestErrorCount > 0)) reasons.push('upload_request_errors')
  for (const op of [
    'albums',
    'album_page',
    'album_thumbnail',
    'photos',
    'photo_page',
    'thumbnail',
    'photo_detail',
    'display',
  ]) {
    const m = s?.operations?.['measured:' + op]
    if (!m || !Number.isSafeInteger(m.count) || m.count < limits.minSamplesPerOperation) {
      reasons.push(op + ':insufficient_samples')
      continue
    }
    const media = ['album_thumbnail', 'thumbnail', 'display'].includes(op)
    const ceiling = media ? limits.imageP95Ms : limits.apiP95Ms
    const tailCeiling = media ? limits.imageP99Ms : limits.apiP99Ms
    if (
      ![m.endToEnd?.p95Ms, m.endToEnd?.p99Ms, m.generatorWait?.p95Ms, m.errors].every(
        (n) => Number.isFinite(n) && n >= 0,
      ) ||
      m.endToEnd.p99Ms < m.endToEnd.p95Ms
    ) {
      reasons.push(op + ':invalid_metrics')
      continue
    }
    if (m.endToEnd.p95Ms > ceiling) reasons.push(op + ':latency')
    if (m.endToEnd.p99Ms > tailCeiling) reasons.push(op + ':tail_latency')
    if (m.generatorWait.p95Ms > limits.generatorWaitP95Ms) reasons.push(op + ':generator_queue')
    if (m.errors) reasons.push(op + ':errors')
  }
  if (
    !Array.isArray(database) ||
    !database.length ||
    database.some(
      (x) =>
        x.error ||
        ![x.connections, x.queued, x.processing].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        !Number.isFinite(x.oldestUploadAgeSeconds) ||
        x.oldestUploadAgeSeconds < 0,
    )
  )
    reasons.push('missing_database_samples')
  else {
    if (!coversWindow(database.map((x) => Date.parse(x.at))))
      reasons.push('database_sample_coverage')
    if (database.some((x) => x.connections >= limits.maxDatabaseConnections))
      reasons.push('database_connection_headroom')
    if (database.some((x) => x.queued + x.processing > limits.maxUploadBacklog))
      reasons.push('upload_backlog')
    if (database.some((x) => x.oldestUploadAgeSeconds > limits.maxOldestUploadAgeSeconds))
      reasons.push('upload_queue_age')
    if (database.at(-1).queued || database.at(-1).processing) reasons.push('queue_not_drained')
  }
  if (
    !Array.isArray(result.samples) ||
    result.samples.length < 11 ||
    result.samples.some(
      (x, i, samples) =>
        ![x.at, x.cpu?.user, x.cpu?.system, x.memory?.rss].every(
          (n) => Number.isFinite(n) && n >= 0,
        ) ||
        (i > 0 &&
          (x.at <= samples[i - 1].at ||
            x.cpu.user < samples[i - 1].cpu.user ||
            x.cpu.system < samples[i - 1].cpu.system)),
    )
  )
    reasons.push('missing_generator_samples')
  else {
    const samples = result.samples
    if (!coversWindow(samples.map((x) => x.at))) reasons.push('generator_sample_coverage')
    if (samples.some((x) => x.memory.rss > limits.maxGeneratorRssBytes))
      reasons.push('generator_memory')
    const windows = generatorCpuWindows(samples)
    if (!windows.length) reasons.push('missing_generator_cpu_window')
    if (windows.some((fraction) => fraction / cpuCores > limits.maxGeneratorCpuFraction))
      reasons.push('generator_cpu')
  }
  return { passed: reasons.length === 0, reasons, limits, resources: { cpuCores } }
}
