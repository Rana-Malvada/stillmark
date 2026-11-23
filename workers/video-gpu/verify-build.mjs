// Verify an image without running its worker or connecting to any service.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const expectedCommit = process.argv[2]
if (!/^[a-f0-9]{40}$/.test(expectedCommit || '')) throw Error('Expected an exact Git commit')
const info = JSON.parse(await readFile(new URL('./build-info.json', import.meta.url), 'utf8'))
if (info.sourceCommit !== expectedCommit) throw Error('Worker image source commit mismatch')
const digest = createHash('sha256')
  .update(await readFile(new URL('./worker.mjs', import.meta.url)))
  .digest('hex')
if (digest !== info.bundleSha256) throw Error('Worker image bundle hash mismatch')
console.log(JSON.stringify({ sourceCommit: info.sourceCommit, bundleSha256: digest }))
