/** Prove success and thrown-work cleanup removes only the gate's disposable data. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { withLocalPostgres } from './local-postgres.mjs'

const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim()
const originalGate = process.env.STILLMARK_DATABASE_GATE_RUN
const gate = originalGate ?? randomUUID()
process.env.STILLMARK_DATABASE_GATE_RUN = gate
const before = new Set(docker('volume', 'ls', '-q').split('\n').filter(Boolean))
const created = new Set()
const sentinel = new Error('Expected synthetic workload failure')
try {
  for (const failure of [false, true]) {
    let outcome
    try {
      await withLocalPostgres('cleanup-proof', async ({ admin }) => {
        assert.equal((await admin.query('SELECT 1 AS healthy')).rows[0].healthy, 1)
        const ids = docker('ps', '-q', '--filter', `label=stillmark.database-gate=${gate}`)
          .split('\n')
          .filter(Boolean)
        assert.equal(ids.length, 1)
        const container = JSON.parse(docker('inspect', ids[0]))[0]
        assert.equal(container.HostConfig.AutoRemove, true)
        for (const mount of container.Mounts.filter((mount) => mount.Type === 'volume')) {
          assert.ok(!before.has(mount.Name), 'Fixture must not use pre-existing data')
          created.add(mount.Name)
        }
        if (failure) throw sentinel
      })
    } catch (error) {
      outcome = error
    }
    assert.equal(outcome, failure ? sentinel : undefined)
    assert.equal(docker('ps', '-aq', '--filter', `label=stillmark.database-gate=${gate}`), '')
    const remaining = new Set(docker('volume', 'ls', '-q').split('\n'))
    for (const volume of created)
      assert.ok(!remaining.has(volume), `Leaked fixture volume ${volume}`)
  }
  console.log(
    'Local PostgreSQL success and failure both remove their disposable containers and volumes',
  )
} finally {
  if (originalGate === undefined) delete process.env.STILLMARK_DATABASE_GATE_RUN
  else process.env.STILLMARK_DATABASE_GATE_RUN = originalGate
  // Even when proving a regression, clean only exact fresh fixture volumes, never other data.
  const remaining = new Set(docker('volume', 'ls', '-q').split('\n'))
  for (const volume of created) {
    if (!remaining.has(volume)) continue
    assert.equal(docker('ps', '-aq', '--filter', `volume=${volume}`), '')
    docker('volume', 'rm', volume)
  }
}
