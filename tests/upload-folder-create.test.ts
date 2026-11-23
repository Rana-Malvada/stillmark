import { afterEach, expect, it, vi } from 'vitest'
import { createUploadFolderRequest } from '@/lib/upload/upload-folder-create'
import { UnconfirmedMutationError } from '@/lib/client-operation'

const folder = {
  folderId: 7,
  folderName: 'Summer Trips',
  ownerUsername: 'ALICE',
  canSelect: true,
  canEdit: true,
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('recovers a committed folder after its response is lost without replaying the mutation', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('connection closed'))
    .mockResolvedValueOnce(Response.json([folder]))
  vi.stubGlobal('fetch', fetch)
  await expect(createUploadFolderRequest('  SUMMER   Trips ', 'ALICE')).resolves.toEqual({
    folderId: 7,
  })
  expect(fetch.mock.calls.map(([url, init]) => [url, init.method || 'GET'])).toEqual([
    ['/api/folders', 'POST'],
    ['/api/folders', 'GET'],
  ])
})
it.each(['headers', 'body'])(
  'bounds stalled folder %s and recovers its committed result',
  async (phase) => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetch = vi
      .fn()
      .mockImplementationOnce((_url, init) => {
        signal = init.signal
        return phase === 'headers'
          ? new Promise(() => {})
          : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) })
      })
      .mockResolvedValueOnce(Response.json([folder]))
    vi.stubGlobal('fetch', fetch)
    const result = createUploadFolderRequest('Summer Trips', 'ALICE', 100)
    await vi.advanceTimersByTimeAsync(101)
    await expect(result).resolves.toEqual({ folderId: 7 })
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  },
)
it.each(
  [
    [{ ...folder, ownerUsername: 'BOB' }],
    [{ ...folder, ownerUsername: null }],
    [{ ...folder, canSelect: false }],
    [{ ...folder, canEdit: false }],
    [],
  ].map((folders) => [folders]),
)('never substitutes an inaccessible or another owner folder: %j', async (folders) => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError('lost'))
      .mockResolvedValueOnce(Response.json(folders)),
  )
  await expect(createUploadFolderRequest('Summer Trips', 'ALICE')).rejects.toBeInstanceOf(
    UnconfirmedMutationError,
  )
})
it('reconciles a retry conflict if the original request committed later', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'Already exists' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json([folder]))
  vi.stubGlobal('fetch', fetch)
  await expect(createUploadFolderRequest('Summer Trips', 'ALICE')).resolves.toEqual({ folderId: 7 })
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('preserves permission rejection without reading or retrying', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'Forbidden' }, { status: 403 }))
  vi.stubGlobal('fetch', fetch)
  await expect(createUploadFolderRequest('Summer Trips', 'ALICE')).rejects.toMatchObject({
    status: 403,
  })
  expect(fetch).toHaveBeenCalledOnce()
})
it('bounds the reconciliation read too and never claims success from malformed data', async () => {
  vi.useFakeTimers()
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('lost'))
    .mockImplementationOnce(() => new Promise(() => {}))
  vi.stubGlobal('fetch', fetch)
  const result = expect(
    createUploadFolderRequest('Summer Trips', 'ALICE', 100),
  ).rejects.toBeInstanceOf(UnconfirmedMutationError)
  await vi.advanceTimersByTimeAsync(101)
  await result
  expect(fetch).toHaveBeenCalledTimes(2)
  fetch
    .mockRejectedValueOnce(new TypeError('lost'))
    .mockResolvedValueOnce(Response.json({ folderId: 7 }))
  await expect(createUploadFolderRequest('Summer Trips', 'ALICE', 100)).rejects.toBeInstanceOf(
    UnconfirmedMutationError,
  )
})
it('returns a validated successful create without an extra read', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ folderId: 7 }))
  vi.stubGlobal('fetch', fetch)
  await expect(createUploadFolderRequest('Summer Trips', 'ALICE')).resolves.toEqual({ folderId: 7 })
  expect(fetch).toHaveBeenCalledOnce()
})
