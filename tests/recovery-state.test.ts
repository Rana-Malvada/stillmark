import { expect, it, vi } from 'vitest'
import { latestRequest } from '../lib/latest-request'
import { retainCostSection } from '../lib/costs/cost-refresh-state'
import {
  UPLOAD_ROW_HEIGHT,
  uploadSummary,
  uploadWindow,
} from '../lib/upload/upload-progress-summary'

it('aborts older work and rejects late responses, including after unmount', () => {
  const gate = latestRequest()
  const first = gate.begin()
  const second = gate.begin()
  expect(first.signal.aborted).toBe(true)
  expect(first.current()).toBe(false)
  expect(second.current()).toBe(true)
  gate.cancel()
  expect(second.signal.aborted).toBe(true)
  expect(second.current()).toBe(false)
})
it('retains old successful costs without representing a failure as zero or extending the date window', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-24T18:00:00Z'))
  const failed = { key: 'ai', label: 'AI', rows: [], error: 'unavailable' }
  const old = {
    ...failed,
    error: null,
    rows: [
      { DAY: '2026-10-24', CREDITS: 4 },
      { DAY: '2026-08-01', CREDITS: 5 },
    ],
  }
  const result = retainCostSection(failed, old, '2026-10-24T12:00:00Z')
  expect(result).toMatchObject({
    rows: [{ DAY: '2026-10-24', CREDITS: 4 }],
    error: null,
    stale: true,
    lastSuccessAt: '2026-10-24T12:00:00Z',
  })
  expect(retainCostSection(failed, result, 'later').lastSuccessAt).toBe(result.lastSuccessAt)
  expect(retainCostSection(failed, undefined).error).toBe('unavailable')
  expect(retainCostSection(failed, { ...old, rows: [] }).stale).toBe(true)
  vi.useRealTimers()
})
it('tracks unfinished bytes without counting skipped files or completed transfers twice', () => {
  expect(
    uploadSummary([
      { filename: 'done', phase: 'success', percent: 100, sizeBytes: 100 },
      { filename: 'skip', phase: 'skipped', percent: 100, sizeBytes: 100 },
      {
        filename: 'sending',
        phase: 'uploading',
        percent: 50,
        sizeBytes: 200,
        uploadedBytes: 100,
        transferredBytes: 40,
      },
      { filename: 'waiting', phase: 'waiting', percent: 0, sizeBytes: 100 },
    ]),
  ).toMatchObject({ finished: 2, remaining: 200, transferred: 40, known: true, active: true })
  expect(uploadSummary([{ filename: 'old', phase: 'failed', percent: 0 }]).known).toBe(false)
})
it('bounds upload DOM rows for large batches and near the end', () => {
  expect(uploadWindow(0, 10000)).toMatchObject({ start: 0, end: 9 })
  const end = uploadWindow(UPLOAD_ROW_HEIGHT * 9999, 10000)
  expect(end.end).toBe(10000)
  expect(end.end - end.start).toBeLessThanOrEqual(8)
})
