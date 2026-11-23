import { expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UploadProgressList } from '@/components/upload-progress'

it('does not call a stopped batch with failures complete or 100 percent', () => {
  const html = renderToStaticMarkup(
    React.createElement(UploadProgressList, {
      files: [
        ...Array.from({ length: 260 }, (_, i) => ({
          filename: `saved${i}`,
          percent: 100,
          phase: 'success' as const,
        })),
        ...Array.from({ length: 396 }, (_, i) => ({
          filename: `failed${i}`,
          percent: 100,
          phase: 'failed' as const,
        })),
      ],
    }),
  )
  expect(html).toContain('260 / 656 complete')
  expect(html).toMatch(/Failed<\/dt><dd>396<\/dd>/)
  expect(html).toContain('39%')
  expect(html).not.toContain('>100%</span>')
  expect(html).not.toContain('Upload complete')
})
it('renders only a small visible window for a thousand uploads', () => {
  const html = renderToStaticMarkup(
    React.createElement(UploadProgressList, {
      files: Array.from({ length: 1000 }, (_, i) => ({
        filename: `image-${i}`,
        phase: 'waiting' as const,
        percent: 0,
        sizeBytes: 1024,
      })),
    }),
  )
  expect((html.match(/aria-posinset/g) || []).length).toBe(9)
  expect(html).toContain('0 / 1000 complete')
  expect(html).toContain('Remaining')
})

it('separates network transfers, queued jobs and active processing', () => {
  const html = renderToStaticMarkup(
    React.createElement(UploadProgressList, {
      files: [
        { filename: 'a', phase: 'uploading', percent: 20 },
        {
          filename: 'b',
          phase: 'processing',
          percent: 99,
          serverQueued: true,
          queueState: 'queued',
        },
        {
          filename: 'c',
          phase: 'processing',
          percent: 99,
          serverQueued: true,
          queueState: 'processing',
        },
        { filename: 'd', phase: 'success', percent: 100 },
      ],
    }),
  )
  for (const label of ['Transferring', 'Queued', 'Processing', 'Completed']) {
    expect(html).toMatch(new RegExp(label + '</dt><dd>1</dd>'))
  }
  expect(html).toContain('Uploaded · queued')
  expect(html).toContain('Uploaded · processing')
  expect(html).toContain('every five seconds')
})

it('keeps every summary field present across queue and completion transitions', () => {
  for (const phase of ['waiting', 'uploading', 'processing', 'success', 'failed'] as const) {
    const html = renderToStaticMarkup(
      React.createElement(UploadProgressList, {
        files: [{ filename: 'photo.jpg', phase, percent: phase === 'success' ? 100 : 0 }],
      }),
    )
    expect((html.match(/<dt /g) || []).length).toBe(9)
    for (const label of [
      'Transferring',
      'Queued',
      'Processing',
      'Completed',
      'Waiting',
      'Failed',
      'Remaining',
      'Transfer speed',
      'Transfer time',
    ]) {
      expect(html).toContain(label)
    }
    expect(html).toContain('every five seconds')
  }
})
