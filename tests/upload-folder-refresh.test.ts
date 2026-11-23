import { afterEach, expect, it, vi } from 'vitest'
import { watchUploadFolders } from '@/lib/upload/upload-folder-refresh'

afterEach(() => vi.unstubAllGlobals())
it('refreshes deleted folders and ignores old responses and responses after disposal', async () => {
  const window = new EventTarget()
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  const pending: ((value: unknown) => void)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise((resolve) => pending.push(resolve))),
  )
  const apply = vi.fn()
  const stop = watchUploadFolders(apply)
  window.dispatchEvent(new Event('gallery-folders-changed'))
  pending[1]({ ok: true, json: async () => [] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(apply).toHaveBeenLastCalledWith([])
  pending[0]({ ok: true, json: async () => [{ folderId: 7, canSelect: true }] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(apply).toHaveBeenCalledTimes(1)
  window.dispatchEvent(new Event('focus'))
  stop()
  pending[2]({ ok: true, json: async () => [{ folderId: 8, canSelect: true }] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  window.dispatchEvent(new Event('gallery-folders-changed'))
  expect(apply).toHaveBeenCalledTimes(1)
  expect(pending).toHaveLength(3)
})

it('refreshes on returning to the tab and preserves choices on transient errors', async () => {
  vi.stubGlobal('window', new EventTarget())
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('document', document)
  const visible = { folderId: 1, canSelect: true }
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [visible, { folderId: 2, canSelect: false }],
    })
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
  vi.stubGlobal('fetch', fetcher)
  const apply = vi.fn()
  const stop = watchUploadFolders(apply)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(apply).toHaveBeenLastCalledWith([visible])
  document.dispatchEvent(new Event('visibilitychange'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(apply).toHaveBeenCalledTimes(1)
  document.dispatchEvent(new Event('visibilitychange'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(apply).toHaveBeenLastCalledWith([])
  stop()
})
