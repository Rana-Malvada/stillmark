import { createServer } from 'node:http'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { planRun, runLoad } from '../harness.mjs'
import { planMixed, runMixed } from '../mixed.mjs'
import { createGeneratorTransport } from './transport.mjs'

export function cloudRunLimits(env = process.env) {
  const limit = (name, fallback, maximum) => {
    const raw = env[name]
    if (raw === undefined) return fallback
    if (
      !/^[0-9]+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < 1 ||
      Number(raw) > maximum
    )
      throw Error(`Invalid ${name}`)
    return Number(raw)
  }
  return {
    users: limit('LOAD_TEST_MAX_USERS', 250, 5000),
    requests: limit('LOAD_TEST_MAX_REQUESTS', 256, 1024),
    readBytes: limit('LOAD_TEST_MAX_READ_BYTES', 4 * 1024 ** 3, 16 * 1024 ** 3),
  }
}

// Only deploy behind authenticated SPCS ingress, with an EAI restricted to the test app.
export function validateCloudRun(body, fixtures, origin, limits = cloudRunLimits()) {
  if (!origin || body?.config?.origin !== origin) throw Error('Wrong isolated target')
  if (body.config.workload !== undefined && !['upload', 'mixed'].includes(body.config.workload))
    throw Error('Unknown workload')
  const plan = (body.config.workload === 'mixed' ? planMixed : planRun)(
    body.config,
    body.actors,
    fixtures,
  )
  if (
    plan.users > limits.users ||
    plan.files > 1000 ||
    plan.maxSeconds > 900 ||
    plan.maxRequests > limits.requests ||
    plan.maxBytes > 4 * 1024 ** 3 ||
    (plan.maxReadBytes ?? 0) > limits.readBytes ||
    (plan.readRequestBudget ?? 0) > 100000
  )
    throw Error('Cloud run exceeds finite test budget')
  if (typeof body.key !== 'string' || body.key.length < 32 || !body.attestationEnvelope)
    throw Error('Operator isolation attestation required')
  return plan
}

export async function start() {
  const limits = cloudRunLimits()
  const transport = await createGeneratorTransport(process.env.LOAD_TEST_ORIGIN)
  const manifest = JSON.parse(await readFile('/fixtures/manifest.json', 'utf8'))
  const fixtures = await Promise.all(
    manifest.map(async (f) => {
      if (!/^synthetic-[0-9]+\.jpg$/.test(f.name)) throw Error('Invalid fixture name')
      const bytes = await readFile('/fixtures/' + f.name)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (sha256 !== f.sha256) throw Error('Fixture hash mismatch')
      return {
        name: f.name,
        group: f.group ?? 'standard',
        size: bytes.length,
        sha256,
        readChunk: async (start, end) => bytes.subarray(start, end),
      }
    }),
  )
  const startedAt = new Date().toISOString()
  const cycle = process.env.TEST_CYCLE ?? null
  const results = new Map()
  let active = null
  let activeController = null
  let lifetimeBytes = 0
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    try {
      if (req.method === 'GET' && req.url === '/health')
        return reply(200, {
          ready: true,
          active,
          cycle,
          startedAt,
          transport: transport.configuration,
        })
      if (req.method === 'POST' && req.url === '/stop/' + active && activeController) {
        activeController.abort()
        return reply(202, { stopping: active })
      }
      if (req.method === 'GET' && req.url?.startsWith('/result/')) {
        const id = req.url.slice(8)
        return results.has(id) ? reply(200, results.get(id)) : reply(404, { error: 'Unknown run' })
      }
      if (req.method !== 'POST' || req.url !== '/run') return reply(404, { error: 'Not found' })
      if (active || results.size >= 8) return reply(409, { error: 'Busy or run limit reached' })
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 1024 * 1024) return reply(413, { error: 'Request too large' })
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const group = body.config?.fixtureSet ?? 'standard'
      if (!['standard', 'large'].includes(group)) throw Error('Unknown fixture set')
      const selected = fixtures.filter((f) => f.group === group).slice(0, body.config?.filesPerUser)
      const plan = validateCloudRun(body, selected, process.env.LOAD_TEST_ORIGIN, limits)
      const id = body.config.runId
      if (
        active ||
        results.has(id) ||
        results.size >= 8 ||
        lifetimeBytes + plan.maxBytes + (plan.maxReadBytes ?? 0) > 16 * 1024 ** 3
      )
        return reply(409, { error: 'Run already used or budget exhausted' })
      active = id
      activeController = new AbortController()
      lifetimeBytes += plan.maxBytes + (plan.maxReadBytes ?? 0)
      results.set(id, { state: 'running', startedAt: new Date().toISOString() })
      reply(202, { runId: id, plan })
      const started = Date.now()
      const samples = []
      const cpuStart = process.cpuUsage()
      const loopDelay = monitorEventLoopDelay({ resolution: 20 })
      loopDelay.enable()
      let previousLoop = performance.eventLoopUtilization()
      const captureSample = () => {
        const at = Date.now()
        if (samples.at(-1)?.at === at) return
        const loop = performance.eventLoopUtilization()
        samples.push({
          at,
          cpu: process.cpuUsage(cpuStart),
          memory: process.memoryUsage(),
          eventLoopUtilization: performance.eventLoopUtilization(loop, previousLoop).utilization,
          eventLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
          eventLoopDelayMaxMs: loopDelay.max / 1e6,
        })
        previousLoop = loop
        loopDelay.reset()
      }
      // Include both boundaries even when warmup is zero or drain finishes
      // between interval ticks; coverage gates reject missing run periods.
      captureSample()
      const timer = setInterval(captureSample, 1000)
      const runner = body.config.workload === 'mixed' ? runMixed : runLoad
      runner(body.config, body.actors, selected, {
        key: body.key,
        fetchImpl: transport.fetch,
        signal: activeController.signal,
        attestationEnvelope: body.attestationEnvelope,
      })
        .then((summary) => {
          captureSample()
          results.set(id, {
            state: 'finished',
            transport: transport.configuration,
            startedAt: new Date(started).toISOString(),
            endedAt: new Date().toISOString(),
            wallMs: Date.now() - started,
            samples,
            summary,
          })
          console.log(
            JSON.stringify({ runId: id, passed: summary.passed, completed: summary.completed }),
          )
        })
        .catch(() => results.set(id, { state: 'failed', error: 'Generator failed' }))
        .finally(() => {
          clearInterval(timer)
          loopDelay.disable()
          active = null
          activeController = null
        })
    } catch {
      if (!res.headersSent) reply(400, { error: 'Invalid test request' })
    }
  })
  server.requestTimeout = 30000
  server.listen(3000, '0.0.0.0')
}
if (process.argv[1]?.endsWith('/server.mjs'))
  start().catch(() => {
    process.exitCode = 1
  })
