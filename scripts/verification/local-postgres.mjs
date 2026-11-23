/** Local correctness check, not a load test. Never accepts a remote database URL. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'

export const VECTOR_POSTGRES_IMAGE =
  'pgvector/pgvector:0.8.1-pg17-bookworm@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21'

export async function withLocalPostgres(label, work, { vector = false } = {}) {
  assert.match(label, /^[a-z-]+$/)
  const name = `stillmark-${label}-${randomUUID()}`
  const image = vector ? VECTOR_POSTGRES_IMAGE : 'postgres:17'
  // Disposable verification data may use bounded RAM when the local Docker
  // disk is full. This never changes production storage or deletes host data.
  const tmpfsMb = Number(process.env.STILLMARK_TEST_PG_TMPFS_MB ?? 0)
  assert.ok(tmpfsMb === 0 || (Number.isInteger(tmpfsMb) && tmpfsMb >= 128 && tmpfsMb <= 256))
  const gate = process.env.STILLMARK_DATABASE_GATE_RUN
  if (gate) assert.match(gate, /^[a-f0-9-]{36}$/)
  const clients = new Set()
  let started = false
  const docker = (...args) =>
    execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim()
  try {
    // Fetch the image explicitly before this check; do not hide network setup in test timing.
    docker('image', 'inspect', '--format', '{{.Id}}', image)
    // The database contains synthetic rows only; trust is restricted to a disposable
    // container exposed on loopback, with no host paths or production credentials.
    docker(
      'run',
      '--rm',
      '-d',
      '--name',
      name,
      ...(gate ? ['--label', `stillmark.database-gate=${gate}`] : []),
      '--memory',
      '512m',
      '--cpus',
      '1',
      ...(tmpfsMb
        ? ['--tmpfs', `/var/lib/postgresql/data:rw,size=${tmpfsMb * 1024 * 1024},mode=0700`]
        : []),
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p',
      '127.0.0.1::5432',
      image,
    )
    started = true
    const endpoint = docker('port', name, '5432/tcp')
    assert.match(endpoint, /^127\.0\.0\.1:\d+$/)
    const port = Number(endpoint.split(':')[1])
    async function connect(role) {
      const client = new pg.Client({
        host: '127.0.0.1',
        port,
        user: 'postgres',
        database: 'postgres',
        connectionTimeoutMillis: 1000,
        statement_timeout: 5000,
      })
      try {
        await client.connect()
      } catch (error) {
        await client.end().catch(() => {})
        throw error
      }
      clients.add(client)
      if (role) {
        assert.match(role, /^[a-z_][a-z0-9_]*$/)
        await client.query(`SET ROLE "${role}"`)
      }
      return client
    }
    let admin
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        admin = await connect()
        break
      } catch (error) {
        if (attempt === 99) throw error
        await delay(100)
      }
    }
    assert.ok(admin)
    return await work({
      admin,
      connect,
      clients,
      containerName: name,
      imageId: docker('image', 'inspect', '--format', '{{.Id}}', image),
    })
  } finally {
    await Promise.allSettled([...clients].map((client) => client.end()))
    if (started) docker('rm', '-f', '-v', name)
  }
}
