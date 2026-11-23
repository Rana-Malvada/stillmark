vi.mock('@/lib/upload/upload-pool-client', () => ({
  ensureUploadPoolReady: vi.fn().mockResolvedValue(undefined),
}))
import { afterEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ status: vi.fn(), retry: vi.fn() }))
vi.mock('@/lib/upload/upload-client', () => ({
  uploadFile: vi.fn(),
  checkUploadJobs: m.status,
  retryQueuedUpload: m.retry,
}))
import { UploadQueue } from '@/lib/upload/upload-queue'

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})
const result = { eventId: 3, results: [{ status: 'success', photoId: 7 }] }
it('accepted jobs free all four transfer slots and continue after local files are released', async () => {
  vi.useFakeTimers()
  const send = vi.fn().mockResolvedValue({ queued: true })
  const complete = vi.fn()
  m.status.mockImplementation(async (ids: string[]) => ({
    jobs: ids.map((uploadId) => ({ uploadId, result, state: 'done' })),
  }))
  const q = new UploadQueue(send, complete)
  q.start(
    Array.from({ length: 9 }, (_, i) => new File(['img'], `${i}.jpg`)),
    { eventId: 3 },
    'Album',
  )
  await vi.advanceTimersByTimeAsync(100)
  expect(send).toHaveBeenCalledTimes(9)
  expect(q.snapshot()[0].files.every((f) => f.serverQueued && f.phase === 'processing')).toBe(true)
  await vi.advanceTimersByTimeAsync(1500)
  expect(q.snapshot()[0].files.every((f) => f.phase === 'success')).toBe(true)
  expect(q.snapshot()[0].running).toBe(false)
  expect(m.status).toHaveBeenCalledTimes(1)
})
it('restores processing without original files and retries a server failure without re-upload', async () => {
  vi.useFakeTimers()
  const storage = {
    load: async () => [
      {
        saved: {
          batch: {
            id: 'b',
            label: 'Album',
            running: true,
            files: [
              { filename: 'a.jpg', phase: 'processing' as const, serverQueued: true, percent: 99 },
            ],
          },
          fields: { eventId: 3 },
          uploadIds: ['id'],
          frozen: [{}],
        },
        files: [null],
      },
    ],
    checkpoint: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
  }
  m.status
    .mockResolvedValueOnce({ jobs: [{ uploadId: 'id', state: 'failed', error: 'Retry me' }] })
    .mockResolvedValue({ jobs: [{ uploadId: 'id', state: 'done', result }] })
  m.retry.mockResolvedValue({ queued: true })
  const send = vi.fn()
  const q = new UploadQueue(send, () => {}, storage)
  q.activate()
  await vi.advanceTimersByTimeAsync(1500)
  expect(q.snapshot()[0].needsFiles).toBe(false)
  expect(q.snapshot()[0].files[0].phase).toBe('failed')
  q.retry('b')
  await vi.advanceTimersByTimeAsync(1500)
  expect(m.retry).toHaveBeenCalledWith('id', expect.any(AbortSignal))
  expect(send).not.toHaveBeenCalled()
  expect(q.snapshot()[0].files[0].phase).toBe('success')
})

it('recovers an accepted job after its HTTP acknowledgement was lost', async () => {
  vi.useFakeTimers()
  const storage = {
    load: async () => [
      {
        saved: {
          batch: {
            id: 'lost',
            label: 'Album',
            running: true,
            files: [{ filename: 'a.jpg', phase: 'processing' as const, percent: 99 }],
          },
          fields: { eventId: 3 },
          uploadIds: ['lost-id'],
          frozen: [{}],
        },
        files: [null],
      },
    ],
    checkpoint: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
  }
  m.status.mockResolvedValue({ jobs: [{ uploadId: 'lost-id', state: 'done', result }] })
  const q = new UploadQueue(vi.fn(), () => {}, storage)
  q.activate()
  await vi.advanceTimersByTimeAsync(100)
  expect(q.snapshot()[0].needsFiles).toBe(false)
  expect(q.snapshot()[0].files[0].phase).toBe('success')
})

function savedProcessing(serverQueued = true) {
  return [
    {
      saved: {
        batch: {
          id: 'restored',
          label: 'Album',
          eventId: 3,
          running: true,
          files: [{ filename: 'a.jpg', phase: 'processing' as const, serverQueued, percent: 99 }],
        },
        fields: { eventId: 3 },
        uploadIds: ['stable-upload'],
        frozen: [{}],
      },
      files: [null],
    },
  ]
}
function recoveryStorage() {
  return {
    load: vi.fn().mockResolvedValue(savedProcessing()),
    checkpoint: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    remove: vi.fn(),
  }
}
it('abandoned render instances do no work; only the committed lifetime starts one poll', async () => {
  vi.useFakeTimers()
  const storage = recoveryStorage()
  const completed = vi.fn()
  const send = vi.fn()
  const candidates = Array.from({ length: 80 }, () => new UploadQueue(send, completed, storage))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(storage.load).not.toHaveBeenCalled()
  expect(m.status).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  const committed = candidates.at(-1)!
  m.status.mockResolvedValue({ jobs: [{ uploadId: 'stable-upload', state: 'done', result }] })
  const release = committed.activate()
  committed.activate() // Repeated activation within one lifetime is idempotent.
  await vi.advanceTimersByTimeAsync(999)
  expect(m.status).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(storage.load).toHaveBeenCalledTimes(1)
  expect(m.status).toHaveBeenCalledTimes(1)
  expect(m.status.mock.calls[0][0]).toEqual(['stable-upload'])
  expect(committed.snapshot()[0].files[0].phase).toBe('success')
  expect(completed).toHaveBeenCalledTimes(1)
  expect(send).not.toHaveBeenCalled()
  expect(m.retry).not.toHaveBeenCalled()
  release()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(m.status).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
it('cleanup during storage restore cannot create monitors or publish recovered state', async () => {
  vi.useFakeTimers()
  const storage = recoveryStorage()
  let finish!: (value: ReturnType<typeof savedProcessing>) => void
  storage.load.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const q = new UploadQueue(vi.fn(), vi.fn(), storage)
  const changed = vi.fn()
  q.subscribe(changed)
  const release = q.activate()
  release()
  finish(savedProcessing())
  await vi.advanceTimersByTimeAsync(60_000)
  expect(q.snapshot()).toEqual([])
  expect(changed).not.toHaveBeenCalled()
  expect(storage.checkpoint).not.toHaveBeenCalled()
  expect(storage.remove).not.toHaveBeenCalled()
  expect(m.status).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
it.each([true, false])(
  'cleanup fences a late status response (known queued=%s)',
  async (serverQueued) => {
    vi.useFakeTimers()
    const storage = recoveryStorage()
    const completed = vi.fn()
    const changed = vi.fn()
    storage.load.mockResolvedValue(savedProcessing(serverQueued))
    let finish!: (value: unknown) => void
    m.status.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const q = new UploadQueue(vi.fn(), completed, storage)
    q.subscribe(changed)
    const release = q.activate()
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.status).toHaveBeenCalledTimes(1)
    const signal: AbortSignal = m.status.mock.calls[0][1]
    const before = q.snapshot()
    release()
    expect(signal.aborted).toBe(true)
    changed.mockClear()
    storage.checkpoint.mockClear()
    finish({ jobs: [{ uploadId: 'stable-upload', state: 'done', result }] })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(q.snapshot()).toBe(before)
    expect(changed).not.toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
    expect(storage.checkpoint).not.toHaveBeenCalled()
    expect(storage.remove).not.toHaveBeenCalled()
    expect(m.status).toHaveBeenCalledTimes(1)
    expect(m.retry).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  },
)
it('effect cleanup and reactivation recover one copy with the same durable upload ID', async () => {
  vi.useFakeTimers()
  const storage = recoveryStorage()
  const completed = vi.fn()
  m.status.mockResolvedValue({ jobs: [{ uploadId: 'stable-upload', state: 'done', result }] })
  const q = new UploadQueue(vi.fn(), completed, storage)
  const firstCleanup = q.activate()
  firstCleanup()
  const finalCleanup = q.activate()
  firstCleanup() // An old effect cleanup cannot dispose the replacement lifetime.
  await vi.advanceTimersByTimeAsync(1000)
  expect(q.snapshot()).toHaveLength(1)
  expect(q.snapshot()[0].files[0].phase).toBe('success')
  expect(m.status).toHaveBeenCalledTimes(1)
  expect(m.status.mock.calls[0][0]).toEqual(['stable-upload'])
  expect(completed).toHaveBeenCalledTimes(1)
  finalCleanup()
  expect(vi.getTimerCount()).toBe(0)
})

it('cleanup settles an active four-slot batch without sending waiting files or restarting monitors', async () => {
  vi.useFakeTimers()
  const finishes: ((value: { queued: true }) => void)[] = []
  const send = vi.fn().mockImplementation(() => new Promise((resolve) => finishes.push(resolve)))
  const completed = vi.fn()
  const changed = vi.fn()
  const q = new UploadQueue(send, completed)
  const release = q.activate()
  q.subscribe(changed)
  q.start(
    Array.from({ length: 8 }, (_, i) => new File(['img'], `${i}.jpg`)),
    { eventId: 3 },
    'Album',
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(send).toHaveBeenCalledTimes(4)
  const before = q.snapshot()
  release()
  changed.mockClear()
  for (const call of send.mock.calls) {
    expect(call[4].aborted).toBe(true)
    call[2]({ phase: 'processing', percent: 99 }) // A late transport progress callback.
  }
  finishes.forEach((finish) => finish({ queued: true }))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(send).toHaveBeenCalledTimes(4)
  expect(q.snapshot()).toBe(before)
  expect(changed).not.toHaveBeenCalled()
  expect(completed).not.toHaveBeenCalled()
  expect(m.status).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('an old transfer cannot change a reactivated queue or release its replacement drain', async () => {
  vi.useFakeTimers()
  let finishOld!: (value: { queued: true }) => void
  const newFinishes: ((value: typeof result) => void)[] = []
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        }),
    )
    .mockImplementation(() => new Promise((resolve) => newFinishes.push(resolve)))
  const completed = vi.fn()
  const q = new UploadQueue(send, completed)
  const release = q.activate()
  const oldId = q.start([new File(['old'], 'old.jpg')], { eventId: 3 }, 'Old')
  await vi.advanceTimersByTimeAsync(0)
  release()
  const finalRelease = q.activate()
  const newId = q.start(
    Array.from({ length: 5 }, (_, i) => new File(['new'], `${i}.jpg`)),
    { eventId: 3 },
    'New',
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(send).toHaveBeenCalledTimes(5) // One interrupted transfer plus four current slots.
  const before = q.snapshot()
  finishOld({ queued: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(q.snapshot()).toBe(before)
  expect(q.snapshot().find((b) => b.id === oldId)?.files[0].phase).toBe('failed')
  // Adding a batch while the replacement drain is busy must not open extra slots.
  q.start([new File(['later'], 'later.jpg')], { eventId: 3 }, 'Later')
  await vi.advanceTimersByTimeAsync(0)
  expect(send).toHaveBeenCalledTimes(5)
  newFinishes.splice(0).forEach((finish) => finish(result))
  await vi.advanceTimersByTimeAsync(0)
  expect(send).toHaveBeenCalledTimes(6)
  newFinishes.splice(0).forEach((finish) => finish(result))
  await vi.advanceTimersByTimeAsync(0)
  expect(send).toHaveBeenCalledTimes(7)
  newFinishes.splice(0).forEach((finish) => finish(result))
  await vi.advanceTimersByTimeAsync(0)
  expect(
    q
      .snapshot()
      .find((b) => b.id === newId)
      ?.files.every((f) => f.phase === 'success'),
  ).toBe(true)
  expect(completed).toHaveBeenCalledTimes(2)
  expect(m.status).not.toHaveBeenCalled()
  finalRelease()
  expect(vi.getTimerCount()).toBe(0)
})

it('cleanup during a processing checkpoint cannot publish a late warning or restart polling', async () => {
  vi.useFakeTimers()
  const storage = recoveryStorage()
  const completed = vi.fn()
  const changed = vi.fn()
  let failCheckpoint!: (error: Error) => void
  storage.checkpoint.mockImplementation(
    () =>
      new Promise((_, reject) => {
        failCheckpoint = reject
      }),
  )
  m.status.mockResolvedValue({ jobs: [{ uploadId: 'stable-upload', state: 'processing' }] })
  const q = new UploadQueue(vi.fn(), completed, storage)
  q.subscribe(changed)
  const release = q.activate()
  await vi.advanceTimersByTimeAsync(1000)
  expect(m.status).toHaveBeenCalledTimes(1)
  expect(storage.checkpoint).toHaveBeenCalled()
  const before = q.snapshot()
  release()
  changed.mockClear()
  failCheckpoint(new Error('Late storage failure'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(q.snapshot()).toBe(before)
  expect(changed).not.toHaveBeenCalled()
  expect(completed).not.toHaveBeenCalled()
  expect(m.status).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('a late server retry cannot affect a replacement lifetime and explicit retry keeps its stable ID', async () => {
  vi.useFakeTimers()
  const storage = recoveryStorage()
  const send = vi.fn()
  const completed = vi.fn()
  m.status
    .mockResolvedValueOnce({
      jobs: [{ uploadId: 'stable-upload', state: 'failed', error: 'Retry me' }],
    })
    .mockResolvedValue({ jobs: [{ uploadId: 'stable-upload', state: 'done', result }] })
  let finish!: (value: { queued: true }) => void
  m.retry
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue({ queued: true })
  const q = new UploadQueue(send, completed, storage)
  const release = q.activate()
  await vi.advanceTimersByTimeAsync(1000)
  q.retry('restored')
  await vi.advanceTimersByTimeAsync(0)
  expect(m.retry).toHaveBeenCalledTimes(1)
  release()
  expect(m.retry.mock.calls[0][1].aborted).toBe(true)
  completed.mockClear()
  const finalRelease = q.activate()
  await vi.advanceTimersByTimeAsync(0)
  const before = q.snapshot()
  finish({ queued: true })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(q.snapshot()).toBe(before)
  expect(m.status).toHaveBeenCalledTimes(1)
  expect(completed).not.toHaveBeenCalled()
  q.retry('restored')
  await vi.advanceTimersByTimeAsync(1000)
  expect(m.retry.mock.calls.map(([id]) => id)).toEqual(['stable-upload', 'stable-upload'])
  expect(q.snapshot()[0].files[0].phase).toBe('success')
  expect(send).not.toHaveBeenCalled()
  finalRelease()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([true, false])(
  'a pending access check cannot resume or warn in a replacement lifetime (allowed=%s)',
  async (allowed) => {
    vi.useFakeTimers()
    const send = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Access expired'), { authenticationRequired: true }),
      )
    const q = new UploadQueue(send)
    const release = q.activate()
    const id = q.start([new File(['img'], 'a.jpg')], { eventId: 3 }, 'Album')
    await vi.advanceTimersByTimeAsync(0)
    expect(q.snapshot()[0].accessIssue).toBe('authentication')
    let finish!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
    )
    const pending = q.resume(id, 'owner')
    release()
    const finalRelease = q.activate()
    const before = q.snapshot()
    finish(
      allowed
        ? Response.json({ authenticated: true, username: 'owner', canManagePersonal: true })
        : new Response('Denied', { status: 403 }),
    )
    await pending
    await vi.advanceTimersByTimeAsync(0)
    expect(q.snapshot()).toBe(before)
    expect(send).toHaveBeenCalledTimes(1)
    finalRelease()
    expect(vi.getTimerCount()).toBe(0)
  },
)
