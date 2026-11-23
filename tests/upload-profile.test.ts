import { describe, expect, it } from 'vitest'
import { profileUpload, uploadStep } from '../lib/upload/upload-profile'

describe('upload profiling', () => {
  it('keeps concurrent profiles separate and preserves results', async () => {
    const [a, b] = await Promise.all([
      profileUpload(() =>
        uploadStep('metadata', async () => {
          await new Promise((r) => setTimeout(r, 5))
          return 7
        }),
      ),
      profileUpload(() => uploadStep('stageWrites', async () => 9)),
    ])
    expect(a.result).toBe(7)
    expect(b.result).toBe(9)
    expect(Object.keys(a.timings)).toEqual(['metadata'])
    expect(Object.keys(b.timings)).toEqual(['stageWrites'])
    expect(a.timings.metadata).toBeGreaterThan(0)
  })
  it('does not swallow errors or change unprofiled work', async () => {
    expect(await uploadStep('metadata', async () => 3)).toBe(3)
    const error = new Error('bad input')
    await expect(
      profileUpload(() =>
        uploadStep('metadata', async () => {
          throw error
        }),
      ),
    ).rejects.toBe(error)
  })
})
