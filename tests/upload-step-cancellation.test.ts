import { expect, it, vi } from 'vitest'
import { databaseContext } from '@/lib/database/database-context'
import { uploadStep } from '@/lib/upload/upload-profile'

it('stops between native decode completion and stage writes after a lease loss', async () => {
  const controller = new AbortController()
  const write = vi.fn()
  await expect(
    databaseContext.run({ kind: 'request', signal: controller.signal }, async () => {
      await uploadStep('renditions', async () => {
        controller.abort(new Error('lease lost'))
        return Buffer.from('image')
      })
      await uploadStep('stageWrites', write)
    }),
  ).rejects.toThrow('lease lost')
  expect(write).not.toHaveBeenCalled()
})
it('does not start a stage after its request was cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  const work = vi.fn()
  await expect(
    databaseContext.run({ kind: 'request', signal: controller.signal }, () =>
      uploadStep('metadata', work),
    ),
  ).rejects.toThrow()
  expect(work).not.toHaveBeenCalled()
})
