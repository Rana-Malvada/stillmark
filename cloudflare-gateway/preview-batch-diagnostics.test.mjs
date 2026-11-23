import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPreviewBatchRecorder } from './preview-batch-diagnostics.mjs'

const enabled = { GATEWAY_DIAGNOSTICS: 'enabled' }
test('disabled and fast successful batches do not emit diagnostics', () => {
  const records = []
  const start = createPreviewBatchRecorder({ log: (value) => records.push(value) })
  assert.equal(start({}, { signingMs: 1, count: 8, reused: 0 }), undefined)
  const observe = start(enabled, { signingMs: 100, count: 1, reused: 0 })
  observe({ type: 'complete', status: 200, elapsedMs: 500, bytes: 10 })
  assert.deepEqual(records, [])
})

test('slow batches separate signing, storage headers, body reads, and frame enqueue', () => {
  const records = []
  const observe = createPreviewBatchRecorder({ log: (value) => records.push(JSON.parse(value)) })(
    enabled,
    { signingMs: 200, count: 2, reused: 1 },
  )
  observe({ type: 'item-headers', index: 0, headerMs: 1500, url: 'secret', path: 'private' })
  observe({ type: 'item-body', index: 0, bodyMs: 900, status: 200, bytes: 1000 })
  observe({ type: 'item-frame', index: 0, elapsedMs: 2400 })
  observe({ type: 'item-body', index: 1, bodyMs: 0, status: 304, bytes: 0 })
  observe({ type: 'item-frame', index: 1, elapsedMs: 2401 })
  observe({ type: 'complete', status: 200, elapsedMs: 2402, bytes: 1200 })
  assert.deepEqual(records, [
    {
      event: 'preview_batch_phases',
      status: 200,
      count: 2,
      reused: 1,
      signingMs: 200,
      streamMs: 2402,
      firstFrameMs: 2400,
      lastFrameMs: 2401,
      bytes: 1200,
      items: [
        { index: 0, headerMs: 1500, bodyMs: 900, status: 200, bytes: 1000, frameMs: 2400 },
        { index: 1, headerMs: 0, bodyMs: 0, status: 304, bytes: 0, frameMs: 2401 },
      ],
    },
  ])
  assert.doesNotMatch(JSON.stringify(records), /secret|private|url|path/)
})

test('failure logging has a twenty-per-minute per-isolate ceiling', () => {
  let time = 0
  const records = []
  const start = createPreviewBatchRecorder({ now: () => time, log: (v) => records.push(v) })
  const emit = () =>
    start(enabled, { signingMs: 0, count: 1, reused: 0 })({
      type: 'complete',
      status: 499,
      elapsedMs: 20,
      bytes: 0,
    })
  for (let i = 0; i < 25; i++) emit()
  assert.equal(records.length, 20)
  time = 60000
  emit()
  assert.equal(records.length, 21)
})

test('a fast failed image is recorded even when its batch stream completed successfully', () => {
  const records = []
  const observe = createPreviewBatchRecorder({ log: (v) => records.push(JSON.parse(v)) })(enabled, {
    signingMs: 10,
    count: 1,
    reused: 0,
  })
  observe({ type: 'item-body', index: 0, headerMs: 20, bodyMs: 0, status: 502, bytes: 0 })
  observe({ type: 'complete', status: 200, elapsedMs: 30, bytes: 50 })
  assert.equal(records.length, 1)
  assert.equal(records[0].items[0].status, 502)
  assert.equal(records[0].status, 200)
})
