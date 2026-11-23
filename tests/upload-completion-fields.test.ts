import { expect, it } from 'vitest'
import { completionFields } from '@/lib/upload/upload-completion-fields'

it('keeps only the details the server reads and drops everything else', () => {
  expect(
    completionFields({
      uploadId: 'id',
      totalChunks: 2,
      fileName: 'a.jpg',
      folderName: 'Trip',
      folderId: 3,
      eventId: 4,
      eventName: 'Trip',
      sortOrder: 1,
      eventMonth: 5,
      eventYear: 2026,
      location: 'Lisbon',
      thumbnail: 'AAAA',
      queuedProcessing: true,
      retryOnly: true,
      sourceFolder: 'Trip',
      junk: 'x'.repeat(100000),
      __proto__: { polluted: true },
    }),
  ).toEqual({
    uploadId: 'id',
    totalChunks: 2,
    fileName: 'a.jpg',
    folderName: 'Trip',
    folderId: 3,
    eventId: 4,
    eventName: 'Trip',
    sortOrder: 1,
    eventMonth: 5,
    eventYear: 2026,
    location: 'Lisbon',
  })
  expect(completionFields({ fileName: 'a.jpg', eventId: undefined })).toEqual({ fileName: 'a.jpg' })
})
it('rejects oversized known details instead of storing them', () => {
  expect(() => completionFields({ fileName: 'a.jpg', location: 'x'.repeat(9000) })).toThrow(
    expect.objectContaining({ status: 413 }),
  )
  expect(() => completionFields({ eventName: { nested: 'y'.repeat(9000) } })).toThrow(
    expect.objectContaining({ status: 413 }),
  )
  expect(completionFields({ fileName: 'n'.repeat(512), folderName: 'f'.repeat(512) })).toBeTruthy()
})
