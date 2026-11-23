import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { detectUploadResources } from './upload/upload-resource-capacity'

let started = false
/** Isolated diagnostics only; no request data, credentials, paths or identities. */
export function startLoadTestRuntimeSampling() {
  if (
    started ||
    process.env.UPLOAD_REQUEST_TRACE !== 'true' ||
    !/^stillmark_loadtest_[a-z0-9_]+$/.test(process.env.PG_DATABASE ?? '')
  )
    return
  started = true
  const resources = detectUploadResources()
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  let previousCpu = process.cpuUsage()
  let previousTime = performance.now()
  let previousLoop = performance.eventLoopUtilization()
  const timer = setInterval(() => {
    const now = performance.now()
    const cpu = process.cpuUsage()
    const loop = performance.eventLoopUtilization()
    const elapsedMs = now - previousTime
    const utilization = performance.eventLoopUtilization(loop, previousLoop)
    process.stdout.write(
      '[load-test-runtime] ' +
        JSON.stringify({
          at: Date.now(),
          pid: process.pid,
          resources,
          elapsedMs,
          cpuCores:
            (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / (elapsedMs * 1000),
          eventLoopUtilization: utilization.utilization,
          eventLoopDelayP99Ms: delay.percentile(99) / 1e6,
          eventLoopDelayMaxMs: delay.max / 1e6,
          rssBytes: process.memoryUsage().rss,
        }) +
        '\n',
    )
    previousCpu = cpu
    previousTime = now
    previousLoop = loop
    delay.reset()
  }, 10000)
  timer.unref()
}
