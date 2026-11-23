import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@/lib/media/image-urls', () => ({
  getPresignedUrl: vi.fn(async () => 'https://original.example/video'),
}))
import { getPresignedUrl } from '@/lib/media/image-urls'
import { downloadVideoOriginal } from '@/lib/video/video-original-download'
import { VideoPreparationError } from '@/lib/video/video-preparation-error'

const dirs: string[] = []
const options = {
  timeoutMs: 1000,
  messages: { unreadable: 'unreadable', changed: 'changed', incomplete: 'incomplete' },
}
async function destination() {
  const dir = await mkdtemp(join(tmpdir(), 'video-download-test-'))
  dirs.push(dir)
  return join(dir, 'original.mov')
}
function response(chunks: number[][], status = 200) {
  const cancel = vi.fn()
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(Uint8Array.from(chunks[index++]))
      else controller.close()
    },
    cancel,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status })),
  )
  return cancel
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it('streams exact bytes and retains redirect protection and a bounded signal', async () => {
  response([
    [1, 2],
    [3, 4],
  ])
  const path = await destination()
  await downloadVideoOriginal('original.mov', path, 4, options)
  expect([...(await readFile(path))]).toEqual([1, 2, 3, 4])
  expect(getPresignedUrl).toHaveBeenCalledExactlyOnceWith('original.mov')
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    'https://original.example/video',
    expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
  )
})
it('cancels an oversized stream without writing the offending chunk', async () => {
  const cancel = response([
    [1, 2],
    [3, 4],
    [5, 6],
  ])
  const path = await destination()
  await expect(downloadVideoOriginal('o', path, 3, options)).rejects.toThrow('changed')
  expect([...(await readFile(path))]).toEqual([1, 2])
  expect(cancel).toHaveBeenCalledOnce()
})
it('rejects incomplete media rather than handing it to a converter', async () => {
  response([[1, 2]])
  await expect(downloadVideoOriginal('o', await destination(), 4, options)).rejects.toThrow(
    'incomplete',
  )
})
it('cancels failed HTTP response bodies', async () => {
  const cancel = response([[1], [2], [3]], 503)
  await expect(downloadVideoOriginal('o', await destination(), 3, options)).rejects.toThrow(
    'unreadable',
  )
  expect(cancel).toHaveBeenCalledOnce()
})
it('cancels the response when exclusive file creation fails and preserves that file', async () => {
  const cancel = response([[1], [2], [3]])
  const path = await destination()
  await writeFile(path, 'keep')
  await expect(downloadVideoOriginal('o', path, 3, options)).rejects.toMatchObject({
    code: 'EEXIST',
  })
  expect(await readFile(path, 'utf8')).toBe('keep')
  expect(cancel).toHaveBeenCalledOnce()
})
it.each([0, -1, NaN, Infinity, 1.5])(
  'rejects invalid catalog size %s before network access',
  async (size) => {
    response([])
    await expect(
      downloadVideoOriginal('o', await destination(), size, options),
    ).rejects.toBeInstanceOf(VideoPreparationError)
    expect(fetch).not.toHaveBeenCalled()
    expect(getPresignedUrl).not.toHaveBeenCalled()
  },
)
it('does no work when already cancelled', async () => {
  response([])
  const controller = new AbortController()
  controller.abort(new Error('stopped'))
  await expect(
    downloadVideoOriginal('o', await destination(), 3, { ...options, signal: controller.signal }),
  ).rejects.toThrow('stopped')
  expect(fetch).not.toHaveBeenCalled()
  expect(getPresignedUrl).not.toHaveBeenCalled()
})
