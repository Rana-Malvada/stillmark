/** Local HTTP responsiveness during real rank fusion. Synthetic transport handlers;
 * not the production upload pipeline, authorization, object storage, or capacity. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'

const expectedCount = (eligible) =>
  Math.floor(eligible / 5000) * 1000 + Math.min(eligible % 5000, 1000) + 1
const previousTimeout = process.env.SEARCH_REQUEST_TIMEOUT_MS
const previousTmpdir = process.env.TMPDIR
const directory = await mkdtemp(join(tmpdir(), 'stillmark-search-http-'))
let server
// Isolate spill cleanup assertions from unrelated concurrent test processes.
process.env.TMPDIR = directory
try {
  await build({
    stdin: {
      contents: `export { withEligibleMatches, withFusedMatches } from './lib/search/search-eligibility'; export { withSearchRequest } from './lib/search/search-request'; export { databaseSignal } from './lib/database/database-context'; export { searchTimeoutMs } from './lib/search/search-admission';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(directory, 'search.mjs'),
  })
  const {
    withEligibleMatches,
    withFusedMatches,
    withSearchRequest,
    databaseSignal,
    searchTimeoutMs,
  } = await import(pathToFileURL(join(directory, 'search.mjs')))
  const requestTimeoutMs = searchTimeoutMs()
  let activeWork = 0
  const search = withSearchRequest(async (request) => {
    activeWork++
    try {
      const eligible = Number(new URL(request.url).searchParams.get('eligible'))
      const signal = databaseSignal()
      const count = await withEligibleMatches(
        async (after, limit) =>
          Array.from({ length: Math.min(limit, eligible - after) }, (_, i) => after + i + 1),
        async (ids) =>
          new Map(
            ids
              .filter((_, i) => i % 5000 < 1000)
              .map((id) => [id, { reranker_score: id / eligible }]),
          ),
        2,
        async (semantic) =>
          withFusedMatches(
            semantic,
            [1, eligible + 1],
            [2, eligible + 1],
            async (rows) => {
              let count = 0
              for await (const row of rows) {
                assert.ok(row.id > 0)
                count++
              }
              return count
            },
            signal,
          ),
        signal,
      )
      assert.equal(count, expectedCount(eligible))
      return Response.json({ count })
    } finally {
      activeWork--
    }
  })
  const bytes = Buffer.alloc(128 * 1024, 7)
  server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/search')) {
        const response = await search(new Request(`http://127.0.0.1${req.url}`))
        res.writeHead(response.status, { 'Content-Type': 'application/json' })
        res.end(await response.text())
      } else if (req.method === 'POST') {
        let count = 0
        for await (const chunk of req) count += chunk.length
        assert.equal(count, bytes.length)
        res.end('accepted')
      } else {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' })
        res.end(bytes)
      }
    } catch (error) {
      res.writeHead(500)
      res.end(String(error))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const reports = []
  const failures = []
  const scratchBefore = new Set(
    (await readdir(directory)).filter((name) => name.startsWith('stillmark-search-')),
  )
  const check = (condition, message) => {
    if (!condition) failures.push(message)
  }
  for (const [name, concurrent, eligible, allowDeadline, forcedTimeout] of [
    ['baseline', 0, 0, false],
    ['normal-catalog', 1, 84000, false],
    ['four-searches', 4, 1000000, false],
    ['overload-boundary', 1, 10000000, true],
    ['forced-cancel-cleanup', 1, 10000000, true, 100],
  ]) {
    if (forcedTimeout) process.env.SEARCH_REQUEST_TIMEOUT_MS = String(forcedTimeout)
    else if (previousTimeout === undefined) delete process.env.SEARCH_REQUEST_TIMEOUT_MS
    else process.env.SEARCH_REQUEST_TIMEOUT_MS = previousTimeout
    const scenarioTimeoutMs = searchTimeoutMs()
    const delay = monitorEventLoopDelay({ resolution: 10 })
    const worker = new Worker(new URL('./search-http-probes.mjs', import.meta.url), {
      workerData: { origin, requestTimeoutMs },
    })
    let readyResolve
    let readyReject
    let doneResolve
    let doneReject
    let completed = false
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    const done = new Promise((resolve, reject) => {
      doneResolve = resolve
      doneReject = reject
    })
    // Attach before startup so a failed client cannot become an unhandled rejection.
    done.catch(() => {})
    worker.on('message', (message) => {
      if (message.type === 'ready') readyResolve()
      else if (message.type === 'complete' || message.type === 'failed') {
        completed = true
        if (message.type === 'failed') readyReject(new Error(message.message))
        doneResolve(message)
      }
    })
    worker.on('error', (error) => {
      readyReject(error)
      doneReject(error)
    })
    worker.on('exit', (code) => {
      if (code !== 0 || !completed) {
        const error = new Error(`Probe client exited ${code}`)
        readyReject(error)
        doneReject(error)
      }
    })
    await ready
    delay.enable()
    const started = performance.now()
    let responses = []
    let probeResult
    let cleanupMs = 0
    try {
      if (concurrent)
        responses = await Promise.all(
          Array.from({ length: concurrent }, async () => {
            const begin = performance.now()
            const response = await fetch(`${origin}/search?eligible=${eligible}`)
            return {
              status: response.status,
              body: await response.json(),
              elapsedMs: performance.now() - begin,
            }
          }),
        )
      else await sleep(3000)
      // A504 is not successful work. Verify cancellation settles the real handler
      // and disposes its external-sort files before the next workload starts.
      const cleanupStart = performance.now()
      while (activeWork && performance.now() - cleanupStart < requestTimeoutMs) await sleep(10)
      cleanupMs = performance.now() - cleanupStart
    } finally {
      worker.postMessage('stop')
      try {
        probeResult = await done
      } finally {
        await worker.terminate()
        delay.disable()
      }
    }
    const report = {
      name,
      elapsedMs: performance.now() - started,
      concurrent,
      eligiblePerSearch: eligible,
      requestTimeoutMs: scenarioTimeoutMs,
      responses,
      cleanupMs,
      activeWorkAfter: activeWork,
      eventLoopP99Ms: delay.percentile(99) / 1e6,
      eventLoopMaxMs: delay.max / 1e6,
    }
    check(probeResult.type === 'complete', `${name}: probe failed: ${probeResult.message}`)
    for (const [kind, values] of Object.entries(probeResult.samples)) {
      values.sort((a, b) => a - b)
      report[kind] = {
        count: values.length,
        p50Ms: values[Math.floor(values.length * 0.5)],
        p95Ms: values[Math.floor(values.length * 0.95)],
        p99Ms: values[Math.floor(values.length * 0.99)],
        maxMs: values.at(-1),
      }
      check(values.length > 0, `${name}: no ${kind} requests completed`)
    }
    reports.push(report)
    for (const response of responses) {
      if (response.status === 200)
        check(response.body.count === expectedCount(eligible), `${name}: incomplete fusion results`)
      else {
        check(
          allowDeadline && response.status === 504,
          `${name}: unexpected response ${JSON.stringify(response)}`,
        )
        check(
          response.body.error === 'Search timed out. Please try again.',
          `${name}: unexpected timeout body`,
        )
        check(
          response.elapsedMs >= scenarioTimeoutMs,
          `${name}: timed out before configured deadline`,
        )
      }
      // Use the same 500ms event-loop responsiveness guard as the forced deadline
      // below; the request's production budget itself is never extended.
      check(
        response.elapsedMs < scenarioTimeoutMs + 500,
        `${name}: response exceeded deadline and responsiveness guard`,
      )
    }
    if (forcedTimeout)
      check(
        responses.every((response) => response.status === 504),
        `${name}: forced cancellation did not occur`,
      )
    check(activeWork === 0, `${name}: cancelled work did not settle`)
    const leaked = (await readdir(directory)).filter(
      (name) => name.startsWith('stillmark-search-') && !scratchBefore.has(name),
    )
    check(leaked.length === 0, `${name}: search scratch files remain after settlement`)
    // Local transport responsiveness budget, not a production capacity promise:
    // search may add at most one 100ms perceptible delay at p99 to idle baseline;
    // 250ms absolute p99 and 500ms maximum loop stall prevent a slow baseline masking failure.
    for (const kind of ['media', 'upload']) {
      check(report[kind].p99Ms <= 250, `${name}: ${kind} p99 exceeded 250ms absolute budget`)
      if (name !== 'baseline')
        check(
          report[kind].p99Ms <= reports[0][kind].p99Ms + 100,
          `${name}: ${kind} p99 added more than 100ms to baseline`,
        )
    }
    check(report.eventLoopMaxMs < 500, `${name}: server event loop stalled 500ms`)
  }
  // The actual request wrapper must reject work at its configured deadline.
  process.env.SEARCH_REQUEST_TIMEOUT_MS = '100'
  const deadlineStart = performance.now()
  const timed = await withSearchRequest(async (req) => {
    await sleep(1000, undefined, { signal: req.signal })
    return Response.json({ unexpected: true })
  })(new Request('http://localhost/deadline'))
  check(timed.status === 504, 'Forced request deadline did not return504')
  check(performance.now() - deadlineStart < 500, 'Forced request deadline exceeded500ms guard')
  console.log(
    JSON.stringify(
      {
        scope:
          'Local loopback HTTP and actual search sorting/fusion/request deadline. Media/upload handlers are synthetic, not production pipeline; excludes providers, storage and authorization.',
        reports,
        failures,
        deadline: { status: timed.status, elapsedMs: performance.now() - deadlineStart },
      },
      null,
      2,
    ),
  )
  assert.deepEqual(
    failures,
    [],
    'HTTP responsiveness/completion contract failed; see measurements above',
  )
} finally {
  if (previousTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpdir
  if (previousTimeout === undefined) delete process.env.SEARCH_REQUEST_TIMEOUT_MS
  else process.env.SEARCH_REQUEST_TIMEOUT_MS = previousTimeout
  if (server) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  await rm(directory, { recursive: true, force: true })
}
