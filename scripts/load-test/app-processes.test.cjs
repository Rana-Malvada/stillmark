const { test } = require('node:test')
const assert = require('node:assert/strict')
const { processPlan } = require('./app-processes.cjs')

const base = {
  LOAD_TEST_APP_PROCESSES: '2',
  PG_DATABASE: 'stillmark_loadtest_baseline',
  BACKGROUND_JOBS_ENABLED: 'false',
  UPLOAD_PROCESSING_WORKER_ENABLED: 'false',
  PG_APP_POOL_MAX: '80',
  PG_MAINTENANCE_POOL_MAX: '2',
  PG_QUEUE_POOL_MAX: '1',
  PG_INDEPENDENT_POOL_MAX: '1',
}
test('splits existing aggregate connection budget without multiplying it', () => {
  const p = processPlan(base)
  assert.equal(p.count, 2)
  assert.deepEqual(
    p.workers.map((w) => w.PG_APP_POOL_MAX),
    ['39', '39'],
  )
  const names = Object.keys(base).filter((k) => k.endsWith('_POOL_MAX'))
  assert.equal(
    p.workers.reduce((n, w) => n + names.reduce((s, k) => s + Number(w[k]), 0), 0),
    84,
  )
  assert.equal(base.PG_APP_POOL_MAX, '80')
})
test('rejects production or enabled maintenance and invalid budgets', () => {
  for (const patch of [
    { PG_DATABASE: 'postgres' },
    { BACKGROUND_JOBS_ENABLED: 'true' },
    { UPLOAD_PROCESSING_WORKER_ENABLED: 'true' },
    { PG_APP_POOL_MAX: '0' },
    { PG_QUEUE_POOL_MAX: undefined },
    { LOAD_TEST_APP_PROCESSES: '3' },
  ])
    assert.throws(() => processPlan({ ...base, ...patch }))
})
test('one-process default preserves all configuration', () => {
  const env = { PG_DATABASE: 'postgres' }
  assert.deepEqual(processPlan(env), { count: 1, workers: [env] })
})
test('shares HTTP listener, replaces a failed worker, and terminates both workers', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { spawn } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stillmark-cluster-'))
  const entry = path.join(dir, 'server.cjs')
  const launcher = path.join(dir, 'launcher.cjs')
  fs.writeFileSync(
    entry,
    `const http=require('node:http');const server=http.createServer((req,res)=>{res.end(String(process.pid));if(req.url==='/crash')setTimeout(()=>process.exit(1),10)});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,pid:process.pid})));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`,
  )
  fs.writeFileSync(
    launcher,
    `require(${JSON.stringify(path.resolve(__dirname, 'app-processes.cjs'))}).start(${JSON.stringify(entry)});`,
  )
  const child = spawn(process.execPath, [launcher], {
    env: { ...process.env, ...base },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const workers = []
  let pending = ''
  let exited = false
  child.on('exit', () => {
    exited = true
  })
  child.stdout.on('data', (b) => {
    pending += b
    let at
    while ((at = pending.indexOf('\n')) >= 0) {
      workers.push(JSON.parse(pending.slice(0, at)))
      pending = pending.slice(at + 1)
    }
  })
  const wait = async (predicate) => {
    const end = Date.now() + 10000
    while (!predicate()) {
      if (Date.now() > end) throw Error('Lifecycle deadline')
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  try {
    await wait(() => workers.length === 2)
    assert.equal(workers[0].port, workers[1].port)
    const seen = new Set()
    for (let i = 0; i < 12; i++)
      seen.add(
        await (
          await fetch(`http://127.0.0.1:${workers[0].port}`, { headers: { Connection: 'close' } })
        ).text(),
      )
    assert.equal(seen.size, 2)
    await (
      await fetch(`http://127.0.0.1:${workers[0].port}/crash`, { headers: { Connection: 'close' } })
    ).text()
    await wait(() => workers.length === 3)
    assert.equal(new Set(workers.map((w) => w.pid)).size, 3)
    child.kill('SIGTERM')
    await wait(() => exited)
    for (const w of workers) assert.throws(() => process.kill(w.pid, 0))
  } finally {
    if (!exited) child.kill('SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
test('stops after repeated worker crashes instead of restarting forever', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { spawn } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stillmark-crash-limit-'))
  const entry = path.join(dir, 'server.cjs')
  const launcher = path.join(dir, 'launcher.cjs')
  fs.writeFileSync(entry, 'process.exit(1)')
  fs.writeFileSync(
    launcher,
    `require(${JSON.stringify(path.resolve(__dirname, 'app-processes.cjs'))}).start(${JSON.stringify(entry)});`,
  )
  const child = spawn(process.execPath, [launcher], {
    env: { ...process.env, ...base },
    stdio: 'ignore',
  })
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(Error('Crash-loop deadline'))
      }, 10000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    assert.equal(code, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
