/** Probe client runs outside the measured search-server event loop, like a browser. */
import { parentPort, workerData } from 'node:worker_threads'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

const { origin, requestTimeoutMs } = workerData
const bytes = Buffer.alloc(128 * 1024, 7)
const samples = { media: [], upload: [] }
let running = true
parentPort.on('message', (message) => {
  if (message === 'stop') running = false
})
async function probe(i, record) {
  const kind = i < 4 ? 'media' : 'upload'
  const begin = performance.now()
  const response = await fetch(`${origin}/${kind}`, {
    ...(kind === 'upload' ? { method: 'POST', body: bytes } : {}),
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  assert.equal(response.status, 200)
  if (kind === 'media') {
    const result = new Uint8Array(await response.arrayBuffer())
    assert.equal(result.length, bytes.length)
    assert.equal(result[0], 7)
    assert.equal(result.at(-1), 7)
  } else assert.equal(await response.text(), 'accepted')
  if (record) samples[kind].push(performance.now() - begin)
}
try {
  // Every scenario starts with established clients. A fresh worker's lazy fetch
  // initialization must not masquerade as search-induced server latency, especially
  // in the brief normal/forced-cancel cases with only a few samples.
  await Promise.all(Array.from({ length: 6 }, (_, i) => probe(i, false)))
  parentPort.postMessage({ type: 'ready' })
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      (async () => {
        while (running) {
          await probe(i, true)
          await sleep(20)
        }
      })(),
    ),
  )
  parentPort.postMessage({ type: 'complete', samples })
} catch (error) {
  running = false
  parentPort.postMessage({ type: 'failed', message: error.message, samples })
} finally {
  parentPort.close()
}
