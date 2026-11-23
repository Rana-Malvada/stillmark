// Local image smoke only: no credentials, cloud traffic, or production media.
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const image = process.argv[2] || 'stillmark-upload:test'
const names = [0, 1].map((i) => `stillmark-upload-smoke-${process.pid}-${i}`)
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
try {
  for (const name of names)
    docker('run', '-d', '--name', name, '--cpus=1', '--memory=5g', '-p', '127.0.0.1::3000', image)
  for (const name of names) {
    const origin = 'http://' + docker('port', name, '3000/tcp')
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(origin + '/api/health/live', {
          signal: AbortSignal.timeout(1000),
        })
        if (response.ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.ok(ready, 'Container never became ready')
    for (const path of ['/', '/api/events', '/api/costs', '/api/ai-categorize'])
      assert.equal((await fetch(origin + path)).status, 404, path)
    assert.equal((await fetch(origin + '/api/upload/chunk')).status, 401)
    assert.equal((await fetch(origin + '/api/upload/complete', { method: 'POST' })).status, 401)
    assert.equal(
      docker(
        'exec',
        name,
        'node',
        '-e',
        `require('sharp')({create:{width:64,height:64,channels:3,background:'white'}}).jpeg().toBuffer().then(b=>require('sharp')(b).metadata()).then(m=>{if(m.width!==64)process.exit(1);console.log('sharp-ok')})`,
      ),
      'sharp-ok',
    )
    docker('exec', name, '/app/bin/ffprobe', '-version')
  }
  console.log(
    'Two isolated upload replicas passed health, route isolation, authentication rejection, Sharp and ffprobe checks.',
  )
} finally {
  for (const name of names) {
    try {
      docker('rm', '-f', name)
    } catch {}
  }
}
