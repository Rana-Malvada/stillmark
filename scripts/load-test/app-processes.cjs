// Isolated experiment: use both available CPU cores without adding app instances.
const cluster = require('node:cluster')
const path = require('node:path')

function processPlan(env) {
  const count = Number(env.LOAD_TEST_APP_PROCESSES || '1')
  if (![1, 2].includes(count)) throw Error('Only one or two app processes are supported')
  if (count === 1) return { count, workers: [{ ...env }] }
  if (
    !/^stillmark_loadtest_[a-z0-9_]+$/.test(env.PG_DATABASE || '') ||
    env.BACKGROUND_JOBS_ENABLED !== 'false' ||
    env.UPLOAD_PROCESSING_WORKER_ENABLED !== 'false'
  )
    throw Error('Multiple processes require isolated database and disabled background workers')
  const names = [
    'PG_APP_POOL_MAX',
    'PG_MAINTENANCE_POOL_MAX',
    'PG_QUEUE_POOL_MAX',
    'PG_INDEPENDENT_POOL_MAX',
  ]
  const budgets = names.map((name) => {
    const n = Number(env[name])
    if (!Number.isInteger(n) || n < 1 || n > 100) throw Error(`Explicit valid ${name} required`)
    return n
  })
  // Each process needs at least one slot in each auxiliary pool. Fund that
  // minimum from the app pool, preserving the configured aggregate budget.
  const extras = budgets.slice(1).reduce((sum, n) => sum + Math.max(0, count - n), 0)
  budgets[0] -= extras
  if (budgets[0] < count) throw Error('Insufficient aggregate connection budget')
  const workers = Array.from({ length: count }, (_, i) => {
    const worker = {
      ...env,
      UPLOAD_RESOURCE_CPU: '1',
      UPLOAD_RESOURCE_MEMORY_MIB: '4096',
      NODE_OPTIONS: ((env.NODE_OPTIONS || '') + ' --max-old-space-size=2048').trim(),
    }
    names.forEach((name, j) => {
      const budget = j === 0 ? budgets[j] : Math.max(count, budgets[j])
      worker[name] = String(Math.floor(budget / count) + (i < budget % count ? 1 : 0))
    })
    return worker
  })
  return { count, workers }
}

function start(entry = path.resolve('.next/standalone/server.js'), env = process.env) {
  const plan = processPlan(env)
  if (plan.count === 1) return require(entry)
  cluster.schedulingPolicy = cluster.SCHED_RR
  cluster.setupPrimary({ exec: entry })
  const slots = new Map()
  const crashes = []
  const timers = new Set()
  let stopping = false
  function stop(code = 0) {
    if (stopping) return
    stopping = true
    process.exitCode = code
    for (const timer of timers) clearTimeout(timer)
    for (const worker of slots.keys()) worker.process.kill('SIGTERM')
    const deadline = setTimeout(() => {
      for (const worker of slots.keys()) worker.process.kill('SIGKILL')
    }, 30000)
    deadline.unref()
  }
  function fork(slot) {
    if (!stopping) slots.set(cluster.fork(plan.workers[slot]), slot)
  }
  cluster.on('exit', (worker) => {
    const slot = slots.get(worker)
    slots.delete(worker)
    if (stopping || slot === undefined) return
    const now = Date.now()
    crashes.push(now)
    while (crashes[0] < now - 60000) crashes.shift()
    if (crashes.length >= 5) return stop(1)
    const timer = setTimeout(
      () => {
        timers.delete(timer)
        fork(slot)
      },
      Math.min(5000, 250 * 2 ** (crashes.length - 1)),
    )
    timers.add(timer)
  })
  process.on('SIGTERM', () => stop())
  process.on('SIGINT', () => stop())
  plan.workers.forEach((_, i) => fork(i))
}
module.exports = { processPlan, start }
if (require.main === module) start()
