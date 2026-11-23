import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { browserUploadStorage, type SavedUpload } from '../lib/upload/upload-storage'

it('stores progress without file blobs and isolates accounts', async () => {
  const alice = browserUploadStorage('alice')
  const bob = browserUploadStorage('bob')
  const saved: SavedUpload = {
    batch: {
      id: 'batch',
      label: 'Trip',
      running: true,
      files: [{ filename: 'a.jpg', phase: 'waiting', percent: 0 }],
    },
    fields: { eventId: 3 },
    uploadIds: ['upload-id'],
    frozen: [null],
  }
  await alice.create(saved, [new File(['photo'], 'a.jpg')])
  expect(await bob.load()).toEqual([])
  const restored = await alice.load()
  expect(restored).toHaveLength(1)
  expect(restored[0].saved.uploadIds).toEqual(['upload-id'])
  expect(restored[0].files[0]).toBeNull()
  await alice.checkpoint(saved, 0)
  expect((await alice.load())[0].files[0]).toBeNull()
  await alice.remove('batch')
  expect(await alice.load()).toEqual([])
})
