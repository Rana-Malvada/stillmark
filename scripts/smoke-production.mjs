// Run after npm run build. Uses only localhost; background jobs stay disabled.
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const port = 3219
const server = spawn(process.execPath, ['.next/standalone/server.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    DEV_AUTH: 'true',
    BACKGROUND_JOBS_ENABLED: 'false',
    CUSTOMER_ACCOUNTS_ENABLED: 'true',
    PREVIEW_BATCH_ENABLED: 'true',
    APP_PERMISSION_AUTHORITY: 'postgres',
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
server.stdout.on('data', (chunk) => (logs += chunk))
server.stderr.on('data', (chunk) => (logs += chunk))
const base = `http://127.0.0.1:${port}`
try {
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${logs}`)
    try {
      ready = (await fetch(`${base}/api/health/live`)).ok
    } catch {}
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.ok(ready, `Server did not start: ${logs}`)
  for (const path of [
    '/',
    '/admin/upload',
    '/admin/access',
    '/api/admin/access',
    '/admin/users-activity',
    '/api/user-activity',
    '/api/user-activity/identity',
    '/api/user-activity/summary',
    '/api/user-activity/export',
    '/api/events',
    '/my-albums',
    '/travels',
    '/api/travels',
    '/api/trash',
    '/api/events/1/sharing',
    '/api/photos/1',
    '/api/photos/download?ids=1',
    '/api/search?q=car',
    '/api/images?path=originals/a.jpg',
    '/api/health/ready',
  ]) {
    const response = await fetch(base + path)
    assert.equal(response.status, 401, path)
  }
  const spoofed = await fetch(`${base}/api/search?q=car`, {
    headers: { 'sf-context-current-user': 'fake', 'sf-context-current-user-token': 'fake' },
  })
  assert.equal(spoofed.status, 401, 'Headers alone must not authenticate outside the runtime')
  const upload = await fetch(`${base}/api/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(upload.status, 401)
  const access = await fetch(`${base}/api/admin/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(access.status, 401)
  const identity = await fetch(`${base}/api/user-activity/identity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"provider":"snowflake"}',
  })
  assert.equal(identity.status, 401)
  // Discover handlers rather than allowing newly added endpoints to silently
  // escape the release access checks. These two probes are intentionally public.
  const publicProbes = new Set(['health/live/route.ts', 'health/upload-ready/route.ts'])
  let apiChecks = 0
  for (const file of readdirSync('app/api', { recursive: true })) {
    if (!file.endsWith('/route.ts') || publicProbes.has(file)) continue
    const source = readFileSync('app/api/' + file, 'utf8')
    const path = '/api/' + file.replace(/\/route\.ts$/, '').replace(/\[[^\]]+\]/g, '1')
    for (const [, method] of source.matchAll(
      /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
    )) {
      for (const spoofed of [false, true]) {
        const response = await fetch(base + path, {
          method,
          headers: {
            Origin: base,
            'Content-Type': 'application/json',
            ...(spoofed
              ? { 'sf-context-current-user': 'fake', 'sf-context-current-user-token': 'fake' }
              : {}),
          },
          ...(method !== 'GET' ? { body: '{}' } : {}),
          signal: AbortSignal.timeout(10000),
        })
        assert.ok(
          [401, 403].includes(response.status),
          `${method} ${path} spoofed=${spoofed}: unexpected ${response.status}`,
        )
        await response.arrayBuffer()
        apiChecks++
      }
    }
  }
  assert.ok(apiChecks >= 200, 'API route discovery missed expected handlers')
  console.log(
    `PASS: liveness, page/access smoke checks and ${apiChecks} discovered API access-boundary checks; no database or Snowflake access.`,
  )
} finally {
  server.kill('SIGTERM')
}
