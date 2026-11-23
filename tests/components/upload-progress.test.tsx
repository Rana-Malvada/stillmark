// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { type FileProgress, UploadProgressList } from '@/components/upload-progress'
import './harness'

const file = (
  filename: string,
  phase: FileProgress['phase'],
  more: Partial<FileProgress> = {},
): FileProgress => ({
  filename,
  phase,
  percent: phase === 'success' || phase === 'skipped' ? 100 : 0,
  ...more,
})
/** The value shown under one of the summary headings (Completed, Failed, …). */
const figure = (label: string) =>
  screen.getAllByRole('term').find((term) => term.textContent === label)?.nextElementSibling
    ?.textContent
const row = (name: string) => screen.getByText(name).closest('li')!

const mixed = [
  file('a.jpg', 'success'),
  file('b.jpg', 'success'),
  file('c.jpg', 'skipped', { photoId: 9, existingFilename: 'old-c.jpg' }),
  file('d.jpg', 'failed', { error: 'The file is not a supported image.' }),
  file('e.jpg', 'uploading', { percent: 50.7 }),
  file('f.jpg', 'waiting'),
  file('g.jpg', 'processing', { percent: 99, serverQueued: true, queueState: 'queued' }),
  file('h.jpg', 'processing', { percent: 99, serverQueued: true, queueState: 'processing' }),
]

it('renders nothing before any file is chosen', () => {
  const view = render(<UploadProgressList files={[]} />)
  expect(view.container.textContent).toBe('')
})

it('counts completed, failed and in-flight files from the given state', () => {
  render(<UploadProgressList files={mixed} />)
  const progress = screen.getByRole('region', { name: 'Upload progress' })
  expect(within(progress).getByText('3 / 8 complete')).toBeTruthy()
  expect(figure('Completed')).toBe('3')
  expect(figure('Failed')).toBe('1')
  expect(figure('Transferring')).toBe('1')
  expect(figure('Waiting')).toBe('1')
  expect(figure('Queued')).toBe('1')
  expect(figure('Processing')).toBe('1')
  // 3 finished (100 each) + 50.7 uploading + two at 99; failed and waiting add nothing.
  const overall = screen.getByRole('progressbar', { name: 'Overall upload progress' })
  expect(overall.getAttribute('aria-valuenow')).toBe('68')
  expect(within(progress).getByText('68%')).toBeTruthy()
})

it('labels each file with where it is in the upload', () => {
  render(
    <UploadProgressList files={[...mixed, file('i.xmp', 'skipped', { skipReason: 'metadata' })]} />,
  )
  expect(within(row('a.jpg')).getByText('Uploaded')).toBeTruthy()
  expect(within(row('e.jpg')).getByText('Uploading 50%')).toBeTruthy()
  expect(within(row('f.jpg')).getByText('Waiting')).toBeTruthy()
  expect(within(row('g.jpg')).getByText('Uploaded · queued')).toBeTruthy()
  expect(within(row('h.jpg')).getByText('Uploaded · processing')).toBeTruthy()
  expect(within(row('i.xmp')).getByText('Ignored metadata')).toBeTruthy()
  expect(
    within(row('c.jpg')).getByRole('link', { name: 'Already in album' }).getAttribute('href'),
  ).toBe('/photos/9')
})

it('offers the reason for a failed file', () => {
  render(<UploadProgressList files={mixed} />)
  const details = screen.getByRole('button', {
    name: 'View upload error for d.jpg: The file is not a supported image.',
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(details)
  const dialog = screen.getByRole('dialog', { name: 'Upload error details' })
  expect(within(dialog).getByText('d.jpg')).toBeTruthy()
  expect(within(dialog).getByText('The file is not a supported image.')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('shows the remaining size only when every unfinished file has a known size', () => {
  const mib = 1024 * 1024
  const view = render(
    <UploadProgressList
      files={[
        file('a.jpg', 'success', { sizeBytes: 8 * mib }),
        file('b.jpg', 'waiting', { sizeBytes: 3 * mib, uploadedBytes: mib }),
      ]}
    />,
  )
  expect(figure('Remaining')).toBe('2.0 MiB')
  view.rerender(<UploadProgressList files={[file('a.jpg', 'success'), file('b.jpg', 'waiting')]} />)
  expect(figure('Remaining')).toBe('—')
})

it('summarises every file of a large batch while rendering only a window of rows', () => {
  const files = Array.from({ length: 500 }, (_, i) =>
    file(`photo-${i}.jpg`, i < 320 ? 'success' : i < 325 ? 'failed' : 'waiting'),
  )
  render(<UploadProgressList files={files} />)
  expect(screen.getByText('320 / 500 complete')).toBeTruthy()
  expect(figure('Completed')).toBe('320')
  expect(figure('Failed')).toBe('5')
  expect(figure('Waiting')).toBe('175')
  expect(screen.queryByText('photo-499.jpg')).toBeNull()
  // Rendered rows still announce their place in the whole batch.
  expect(row('photo-0.jpg').getAttribute('aria-setsize')).toBe('500')
})

it('keeps a per-file bar within 0–100 whatever percent it is given', () => {
  render(<UploadProgressList files={[file('a.jpg', 'uploading', { percent: 150 })]} />)
  const bar = screen.getByRole('progressbar', { name: 'Upload progress for a.jpg' })
  expect(bar.getAttribute('aria-valuenow')).toBe('100')
})
