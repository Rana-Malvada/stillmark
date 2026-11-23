import { afterEach, expect, it, vi } from 'vitest'
import { isBatchUploading, UploadQueue } from '../lib/upload/upload-queue'

vi.mock('@/lib/upload/upload-client', () => ({ uploadFile: vi.fn() }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const file = (name: string) => new File(['image'], name)
const result = (id = 42) => ({ eventId: id, results: [{ status: 'success', photoId: 1 }] })
const until = async (test: () => boolean) => {
  for (let i = 0; i < 50 && !test(); i++) await new Promise((r) => setTimeout(r, 0))
  expect(test()).toBe(true)
}
it('continues after the upload screen unsubscribes and exposes results on another screen', async () => {
  let finish!: (value: unknown) => void
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(result())
  const completed = vi.fn()
  const queue = new UploadQueue(send, completed)
  const leave = queue.subscribe(() => {})
  queue.start([file('one.jpg'), file('two.jpg')], { folderName: 'Trip' }, 'Trip')
  leave()
  await until(() => send.mock.calls.length === 2)
  finish(result())
  await until(() => !queue.snapshot()[0].running)
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1][1].folderName).toBe('Trip')
  expect(queue.snapshot()[0].files.map((f) => f.phase)).toEqual(['success', 'success'])
  expect(completed).toHaveBeenCalledWith(42)
})
it('serializes batches from different screens and retries only failures', async () => {
  let finish!: (value: unknown) => void
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValue(result(7))
  const queue = new UploadQueue(send)
  queue.start([file('one.jpg')], { eventId: 42 }, 'One')
  const second = queue.start([file('two.jpg'), file('three.jpg')], { eventId: 7 }, 'Two')
  await until(() => send.mock.calls.length === 1)
  finish(result())
  await until(() => queue.snapshot().every((b) => !b.running))
  expect(queue.snapshot()[1].files.map((f) => f.phase)).toEqual(['failed', 'success'])
  queue.retry(second)
  await until(() => queue.snapshot().every((b) => !b.running))
  expect(send).toHaveBeenCalledTimes(4)
  expect(send.mock.calls[3][0].name).toBe('two.jpg')
  expect(queue.snapshot()[1].files.every((f) => f.phase === 'success')).toBe(true)
  queue.dismiss(second)
  expect(queue.snapshot()).toHaveLength(1)
})
it('restores interrupted work with the same IDs and releases completed local files', async () => {
  vi.stubGlobal('navigator', {}) // A closed browser releases its Web Lock.
  let saved: any
  let blobs: (File | null)[] = []
  const storage = {
    load: async () => (saved ? [{ saved: structuredClone(saved), files: [...blobs] }] : []),
    create: async (s: any, f: File[]) => {
      saved = structuredClone(s)
      blobs = [...f]
    },
    checkpoint: async (s: any, index?: number) => {
      saved = structuredClone(s)
      if (index !== undefined) blobs[index] = null
    },
    remove: async () => {
      saved = null
      blobs = []
    },
  }
  const interrupted = vi.fn().mockImplementation(() => new Promise(() => {}))
  const queue = new UploadQueue(interrupted, () => {}, storage)
  queue.start([file('recover.jpg')], { folderName: 'Original' }, 'Trip')
  await until(() => interrupted.mock.calls.length === 1)
  const originalId = interrupted.mock.calls[0][3]
  const resumedSend = vi.fn().mockResolvedValue(result())
  const recovered = new UploadQueue(resumedSend, () => {}, storage)
  recovered.activate()
  await until(() => recovered.snapshot().length === 1)
  expect(recovered.snapshot()[0].running).toBe(false)
  expect(recovered.snapshot()[0].recovered).toBe(true)
  recovered.retry(recovered.snapshot()[0].id)
  await until(() => resumedSend.mock.calls.length === 1 && !recovered.snapshot()[0].running)
  expect(resumedSend.mock.calls[0][3]).toBe(originalId)
  expect(blobs[0]).toBeNull()
})
it('warns when local quota prevents restart recovery without losing the active upload', async () => {
  const storage = {
    load: async () => [],
    create: async () => {
      throw new Error('Quota exceeded')
    },
    checkpoint: async () => {},
    remove: async () => {},
  }
  const queue = new UploadQueue(vi.fn().mockResolvedValue(result()), () => {}, storage)
  queue.start([file('one.jpg')], {}, 'Trip')
  await until(() => !queue.snapshot()[0].running)
  expect(queue.snapshot()[0].warning).toContain('Unable to save upload progress')
  expect(queue.snapshot()[0].files[0].phase).toBe('success')
})

it('excludes hidden macOS sidecars from new uploads and totals', async () => {
  const send = vi.fn().mockResolvedValue(result())
  const queue = new UploadQueue(send)
  const resource = file('copy.jpg')
  Object.defineProperty(resource, 'webkitRelativePath', { value: 'Trip/__MACOSX/copy.jpg' })
  queue.start([file('._photo.jpeg'), resource, file('photo.jpeg')], { eventId: 42 }, 'Trip')
  await until(() => !queue.snapshot()[0].running)
  expect(send).toHaveBeenCalledTimes(1)
  expect(queue.snapshot()[0].files.map((f) => f.filename)).toEqual(['photo.jpeg'])
})
it('ignores saved metadata on resume without uploading it or changing real file session IDs', async () => {
  const saved = {
    batch: {
      id: 'old',
      label: 'Trip',
      running: false,
      files: [
        { filename: '._photo.jpeg', phase: 'failed', percent: 0 },
        { filename: 'photo.jpeg', phase: 'failed', percent: 0 },
      ],
    },
    fields: { eventId: 42 },
    uploadIds: ['sidecar-id', 'photo-id'],
    frozen: [null, null],
  }
  const storage = {
    load: async () => [{ saved, files: [file('._photo.jpeg'), file('photo.jpeg')] }],
    create: vi.fn(),
    checkpoint: vi.fn(),
    remove: vi.fn(),
  }
  const send = vi.fn().mockResolvedValue(result())
  const queue = new UploadQueue(send, () => {}, storage as any)
  queue.activate()
  await until(() => queue.snapshot().length === 1)
  queue.retry('old')
  await until(() => !queue.snapshot()[0].running)
  expect(send).toHaveBeenCalledTimes(1)
  expect(send.mock.calls[0][3]).toBe('photo-id')
  expect(queue.snapshot()[0].files[0]).toMatchObject({
    phase: 'skipped',
    skipReason: 'metadata',
    percent: 100,
  })
  expect(storage.checkpoint).toHaveBeenCalledWith(expect.anything(), 0)
})

it('runs four file uploads concurrently and starts a fifth only when a slot opens', async () => {
  const finishes: Array<(v: unknown) => void> = []
  let active = 0
  let peak = 0
  const send = vi.fn(() => {
    active++
    peak = Math.max(peak, active)
    return new Promise<Awaited<ReturnType<typeof import('@/lib/upload/upload-client').uploadFile>>>(
      (resolve) =>
        finishes.push((v) => {
          active--
          resolve(v as Awaited<ReturnType<typeof import('@/lib/upload/upload-client').uploadFile>>)
        }),
    )
  })
  const queue = new UploadQueue(send)
  queue.start(
    Array.from({ length: 6 }, (_, i) => file(`${i}.jpg`)),
    { eventId: 42 },
    'Parallel',
  )
  await until(() => send.mock.calls.length === 4)
  expect(active).toBe(4)
  finishes[0](result())
  await until(() => send.mock.calls.length === 5)
  finishes[1](result())
  await until(() => send.mock.calls.length === 6)
  for (let i = 2; i < 6; i++) finishes[i](result())
  await until(() => !queue.snapshot()[0].running)
  expect(peak).toBe(4)
  expect(queue.snapshot()[0].files.every((f) => f.phase === 'success')).toBe(true)
})

it('pauses an expired session before starting more files and retries with stable IDs', async () => {
  const send = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('Sign in again'), { authenticationRequired: true }))
  const completed = vi.fn()
  const queue = new UploadQueue(send, completed)
  const id = queue.start(
    Array.from({ length: 12 }, (_, i) => file(`${i}.jpg`)),
    { eventId: 42 },
    'Trip',
  )
  await until(() => !queue.snapshot()[0].running)
  expect(send).toHaveBeenCalledTimes(4)
  expect(completed).not.toHaveBeenCalled()
  expect(queue.snapshot()[0].warning).toContain('Sign in again')
  const firstId = send.mock.calls[0][3]
  send.mockResolvedValue(result())
  queue.retry(id)
  await until(() => !queue.snapshot()[0].running)
  expect(send).toHaveBeenCalledTimes(16)
  expect(send.mock.calls[4][3]).toBe(firstId)
  expect(queue.snapshot()[0].files.every((f) => f.phase === 'success')).toBe(true)
})

it('clears finished status even when browser checkpoint storage stalls', async () => {
  vi.useFakeTimers()
  const storage = {
    load: async () => [],
    create: async () => {},
    checkpoint: vi
      .fn()
      .mockImplementation((_s: any, index?: number) =>
        index === undefined ? Promise.resolve() : new Promise(() => {}),
      ),
    remove: async () => {},
  }
  const completed = vi.fn()
  const send = vi.fn().mockResolvedValue(result())
  const queue = new UploadQueue(send, completed, storage)
  const id = queue.start([file('one.jpg')], { eventId: 42 }, 'Trip')
  await vi.advanceTimersByTimeAsync(0)
  expect(queue.snapshot()[0].files[0].phase).toBe('success')
  expect(isBatchUploading(queue.snapshot()[0])).toBe(false)
  await vi.advanceTimersByTimeAsync(5001)
  expect(queue.snapshot()[0].running).toBe(false)
  expect(completed).toHaveBeenCalledWith(42)
  expect(send).toHaveBeenCalledTimes(1)
  queue.dismiss(id)
  expect(queue.snapshot()).toEqual([])
})
it('shows uploading only for actual unfinished work', () => {
  expect(
    isBatchUploading({
      id: 'x',
      label: 'x',
      running: true,
      files: [{ filename: 'a', phase: 'processing', percent: 99 }],
    }),
  ).toBe(true)
  expect(
    isBatchUploading({
      id: 'x',
      label: 'x',
      running: true,
      files: [
        { filename: 'a', phase: 'success', percent: 100 },
        { filename: 'b', phase: 'failed', percent: 0 },
      ],
    }),
  ).toBe(false)
})

it('recovers progress without blobs, matches original files, and skips completed entries', async () => {
  const original = new File(['image'], 'resume.jpg', { lastModified: 123 })
  const saved: any = {
    batch: {
      id: 'recovery',
      label: 'Trip',
      running: true,
      files: [
        { filename: 'done.jpg', phase: 'success', percent: 100 },
        { filename: 'resume.jpg', phase: 'processing', percent: 99 },
      ],
    },
    fields: { eventId: 42 },
    uploadIds: ['done-id', 'resume-id'],
    frozen: [null, { eventId: 42 }],
    identities: [
      { name: 'done.jpg', size: 1, lastModified: 1, relativePath: '' },
      { name: 'resume.jpg', size: 5, lastModified: 123, relativePath: '' },
    ],
  }
  const storage = {
    load: async () => [{ saved, files: [null, null] }],
    create: vi.fn(),
    checkpoint: vi.fn(),
    remove: vi.fn(),
  }
  const send = vi.fn().mockResolvedValue(result())
  const queue = new UploadQueue(send, () => {}, storage)
  queue.activate()
  await until(() => queue.snapshot().length === 1)
  expect(queue.snapshot()[0].needsFiles).toBe(true)
  queue.retry('recovery')
  expect(send).not.toHaveBeenCalled()
  queue.reselect('recovery', [new File(['wrong'], 'resume.jpg', { lastModified: 999 })])
  expect(queue.snapshot()[0].needsFiles).toBe(true)
  queue.reselect('recovery', [original])
  expect(queue.snapshot()[0].needsFiles).toBe(false)
  queue.retry('recovery')
  await until(() => !queue.snapshot()[0].running)
  expect(send).toHaveBeenCalledTimes(1)
  expect(send.mock.calls[0][3]).toBe('resume-id')
  expect(queue.snapshot()[0].files.every((f) => f.phase === 'success')).toBe(true)
})

it('cancels active and queued files, preserving successes and stable IDs for retry', async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce(result())
    .mockImplementation(
      (_file, _fields, _progress, _id, signal: AbortSignal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
  const queue = new UploadQueue(send)
  const id = queue.start(
    Array.from({ length: 8 }, (_, i) => file(`${i}.jpg`)),
    {},
    'Trip',
  )
  await until(() => send.mock.calls.length === 5)
  const firstIds = new Map(send.mock.calls.map((call) => [call[0].name, call[3]]))
  queue.cancel(id)
  queue.retry(id) // Must not race workers that are still settling.
  await until(() => !queue.snapshot()[0].running)
  expect(send).toHaveBeenCalledTimes(5)
  expect(queue.snapshot()[0].files.map((f) => f.phase)).toEqual([
    'success',
    ...Array(7).fill('failed'),
  ])
  expect(send.mock.calls.every((call) => call[4].aborted)).toBe(true)
  send.mockResolvedValue(result())
  queue.retry(id)
  await until(() => !queue.snapshot()[0].running)
  expect(send).toHaveBeenCalledTimes(12)
  for (const call of send.mock.calls.slice(5)) {
    expect(call[0].name).not.toBe('0.jpg')
    if (firstIds.has(call[0].name)) expect(call[3]).toBe(firstIds.get(call[0].name))
    expect(call[4].aborted).toBe(false)
  }
  expect(queue.snapshot()[0].files.every((f) => f.phase === 'success')).toBe(true)
})

it('cancels a waiting batch without aborting another batch', async () => {
  let finish!: (value: unknown) => void
  const send = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const queue = new UploadQueue(send)
  queue.start([file('active.jpg')], {}, 'Active')
  const waiting = queue.start([file('waiting.jpg')], {}, 'Waiting')
  await until(() => send.mock.calls.length === 1)
  queue.cancel(waiting)
  expect(send.mock.calls[0][4].aborted).toBe(false)
  expect(queue.snapshot()[1].running).toBe(false)
  finish(result())
  await until(() => !queue.snapshot()[0].running)
  expect(send).toHaveBeenCalledTimes(1)
})

it('checks the original account before resuming and retains selected files', async () => {
  const send = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('Expired'), { authenticationRequired: true }))
  const queue = new UploadQueue(send)
  const original = file('one.jpg')
  const id = queue.start([original], {}, 'Trip')
  await until(() => !queue.snapshot()[0].running)
  const savedId = send.mock.calls[0][3]
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ authenticated: true, username: 'OTHER', canManagePersonal: true }),
    )
    .mockResolvedValueOnce(
      Response.json({ authenticated: true, username: 'OWNER', canManagePersonal: true }),
    )
  vi.stubGlobal('fetch', fetchMock)
  await queue.resume(id, 'OWNER')
  expect(send).toHaveBeenCalledTimes(1)
  expect(queue.snapshot()[0].warning).toContain('same account')
  send.mockResolvedValue(result())
  await queue.resume(id, 'OWNER')
  await until(() => !queue.snapshot()[0].running)
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1][0]).toBe(original)
  expect(send.mock.calls[1][3]).toBe(savedId)
})

it('pauses upstream rejections without telling the user their login expired', async () => {
  const send = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('Gateway rejected request'), { accessIssue: 'upstream' }),
    )
  const queue = new UploadQueue(send)
  queue.start(
    Array.from({ length: 10 }, (_, i) => file(`${i}.jpg`)),
    {},
    'Trip',
  )
  await until(() => !queue.snapshot()[0].running)
  expect(send).toHaveBeenCalledTimes(4)
  expect(queue.snapshot()[0].accessIssue).toBe('upstream')
  expect(queue.snapshot()[0].warning).not.toContain('Sign in again')
})
