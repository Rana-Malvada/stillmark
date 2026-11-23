import { expect, it } from 'vitest'
import { uploadRowOffsets, uploadWindow } from '@/lib/upload/upload-progress-summary'
import type { FileProgress } from '@/components/upload-progress'

it('keeps row offsets unchanged through success, errors and duplicates', () => {
  const base: FileProgress = { filename: 'photo.jpg', percent: 100, phase: 'success' }
  const offsets = uploadRowOffsets([
    base,
    { ...base, phase: 'failed', error: 'Upload failed' },
    { ...base, phase: 'skipped', photoId: 1 },
    base,
  ])
  expect(offsets).toEqual([0, 40, 80, 120, 160])
  expect(uploadRowOffsets(Array(4).fill({ ...base, phase: 'uploading', percent: 20 }))).toEqual(
    offsets,
  )
})

it('covers the viewport and preserves total scroll height across mixed upload states', () => {
  const files: FileProgress[] = Array.from({ length: 1000 }, (_, i) => ({
    filename: `${i}.jpg`,
    percent: 100,
    phase: i % 7 === 0 ? 'failed' : 'success',
    error: i % 7 === 0 ? 'Retry upload' : undefined,
  }))
  const offsets = uploadRowOffsets(files)
  for (const top of [0, 40, 88, 500, 15000, offsets[1000] - 600]) {
    const window = uploadWindow(top, files.length, 600, offsets)
    expect(window.before).toBeLessThanOrEqual(top)
    expect(offsets[window.end]).toBeGreaterThanOrEqual(top + 600)
    expect(window.before + offsets[window.end] - offsets[window.start] + window.after).toBe(
      offsets[1000],
    )
    expect(window.end - window.start).toBeLessThan(24)
  }
})
