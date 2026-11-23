vi.mock('@/lib/upload/upload-pool-client', () => ({
  ensureUploadPoolReady: vi.fn().mockResolvedValue(undefined),
}))
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/video/video-thumbnail', () => ({ generateVideoThumbnail: vi.fn() }))
import {
  checkUploadJobs,
  retryQueuedUpload,
  uploadFile,
  type UploadProgress,
} from '@/lib/upload/upload-client'
import { CHUNK_BYTES } from '@/lib/upload/upload-limits'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function setup(statuses: number[]) {
  const sent: FormData[] = []
  class XHR {
    upload: { onprogress?: (event: object) => void } = {}
    status = 200
    responseText = '{"ok":true,"chunkIndex":0}'
    onload?: () => void
    open = vi.fn()
    send(body: FormData) {
      sent.push(body)
      this.responseText = JSON.stringify({ ok: true, chunkIndex: Number(body.get('chunkIndex')) })
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 })
      this.status = statuses.shift() ?? 200
      this.onload?.()
    }
  }
  vi.stubGlobal('XMLHttpRequest', XHR)
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ eventId: 7, results: [{ status: 'success', photoId: 1 }] })),
    )
  vi.stubGlobal('fetch', fetchMock)
  return { sent, fetchMock }
}
it('reports within-chunk progress and keeps processing below completion', async () => {
  const { sent, fetchMock } = setup([200, 200])
  const progress: UploadProgress[] = []
  await uploadFile(new File([new Uint8Array(CHUNK_BYTES * 2)], 'test.jpg'), {}, (p) =>
    progress.push(p),
  )
  expect(progress).toContainEqual(
    expect.objectContaining({ percent: 25, phase: 'uploading', uploadedBytes: CHUNK_BYTES / 2 }),
  )
  expect(progress).toContainEqual(
    expect.objectContaining({ percent: 75, phase: 'uploading', uploadedBytes: CHUNK_BYTES * 1.5 }),
  )
  expect(progress.at(-1)).toMatchObject({
    percent: 99,
    phase: 'processing',
    uploadedBytes: CHUNK_BYTES * 2,
    transferredBytes: CHUNK_BYTES * 2,
  })
  expect(sent).toHaveLength(2)
  expect(fetchMock.mock.calls[0][0]).toBe('/api/upload/complete')
})
it('retries a chunk with the same session and resets its transfer progress', async () => {
  vi.useFakeTimers()
  const { sent } = setup([503, 200])
  const progress: UploadProgress[] = []
  const promise = uploadFile(new File(['image'], 'test.jpg'), {}, (p) => progress.push(p))
  await vi.runAllTimersAsync()
  await promise
  expect(sent).toHaveLength(2)
  expect(sent[0].get('uploadId')).toBe(sent[1].get('uploadId'))
  expect(progress.map((p) => p.percent)).toEqual([0, 0, 50, 0, 50, 99, 99])
})
it('cancels permanently rejected files so upload slots remain available', async () => {
  const { fetchMock } = setup([413])
  await expect(uploadFile(new File(['image'], 'test.jpg'), {}, () => {})).rejects.toThrow(
    'Upload request failed',
  )
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/upload/chunk?uploadId='), {
    method: 'DELETE',
    signal: expect.any(AbortSignal),
  })
})
it('resumes missing chunks with the saved ID and immutable completion metadata', async () => {
  const { sent, fetchMock } = setup([200])
  fetchMock
    .mockResolvedValueOnce(
      Response.json({
        exists: true,
        totalChunks: 2,
        chunks: [0],
        chunkHashes: { 0: createHash('sha256').update(new Uint8Array(CHUNK_BYTES)).digest('hex') },
        metadata: { folderName: 'Original', eventId: 7 },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ eventId: 7, results: [{ status: 'success', photoId: 1 }] }),
    )
  const id = '11111111-1111-4111-8111-111111111111'
  await uploadFile(
    new File([new Uint8Array(CHUNK_BYTES + 1)], 'test.jpg'),
    { folderName: 'Changed' },
    () => {},
    id,
  )
  expect(sent).toHaveLength(1)
  expect(sent[0].get('chunkIndex')).toBe('1')
  expect(sent[0].get('uploadId')).toBe(id)
  const body = JSON.parse(fetchMock.mock.calls[1][1].body)
  expect(body.folderName).toBe('Original')
  expect(body.eventId).toBe(7)
})
it('returns a committed upload result without retransferring bytes', async () => {
  const { sent, fetchMock } = setup([])
  fetchMock.mockResolvedValueOnce(
    Response.json({
      exists: true,
      totalChunks: 1,
      chunks: [],
      result: { eventId: 7, results: [{ status: 'success', photoId: 1 }] },
    }),
  )
  const result = await uploadFile(
    new File(['image'], 'test.jpg'),
    {},
    () => {},
    '11111111-1111-4111-8111-111111111111',
  )
  expect(!result.queued && result.eventId).toBe(7)
  expect(sent).toHaveLength(0)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('retains partial data after transient retries are exhausted', async () => {
  vi.useFakeTimers()
  const { fetchMock } = setup([503, 503, 503, 503])
  const pending = uploadFile(new File(['image'], 'test.jpg'), {}, () => {})
  const failed = expect(pending).rejects.toThrow('Upload request failed')
  await vi.runAllTimersAsync()
  await failed
  expect(fetchMock).not.toHaveBeenCalledWith(expect.anything(), { method: 'DELETE' })
})

it('reports a plain-text expired session and preserves saved chunks', async () => {
  const { fetchMock, sent } = setup([])
  fetchMock.mockResolvedValueOnce(new Response('Sign in required', { status: 401 }))
  await expect(
    uploadFile(
      new File(['image'], 'test.jpg'),
      {},
      () => {},
      '11111111-1111-4111-8111-111111111111',
    ),
  ).rejects.toThrow('Sign in again')
  expect(sent).toHaveLength(0)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
it('retries a non-JSON gateway failure without losing the upload ID', async () => {
  vi.useFakeTimers()
  const { fetchMock } = setup([])
  fetchMock
    .mockResolvedValueOnce(new Response('<html>Gateway timeout</html>', { status: 504 }))
    .mockResolvedValueOnce(Response.json({ exists: false, chunks: [] }))
  const pending = uploadFile(
    new File(['image'], 'test.jpg'),
    {},
    () => {},
    '11111111-1111-4111-8111-111111111111',
  )
  await vi.runAllTimersAsync()
  await pending
  expect(fetchMock.mock.calls[0][0]).toBe(fetchMock.mock.calls[1][0])
})
it('does not accept a successful HTML login page as a completed upload', async () => {
  vi.useFakeTimers()
  const { fetchMock } = setup([])
  fetchMock.mockImplementation(async () => new Response('<html>Login</html>'))
  const pending = uploadFile(
    new File(['image'], 'test.jpg'),
    {},
    () => {},
    '11111111-1111-4111-8111-111111111111',
  )
  const failed = expect(pending).rejects.toThrow('invalid response')
  await vi.runAllTimersAsync()
  await failed
  expect(fetchMock).toHaveBeenCalledTimes(4)
})
it('retries XHR status zero instead of leaving the upload promise unresolved', async () => {
  vi.useFakeTimers()
  setup([0, 200])
  const pending = uploadFile(new File(['image'], 'test.jpg'), {}, () => {})
  await vi.runAllTimersAsync()
  await pending
})

it('waits out the rate-limit window before retrying the same file', async () => {
  vi.useFakeTimers()
  const { sent } = setup([429, 200])
  const pending = uploadFile(new File(['image'], 'test.jpg'), {}, () => {})
  await vi.advanceTimersByTimeAsync(8000)
  expect(sent).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(53000)
  await pending
  expect(sent).toHaveLength(2)
  expect(sent[0].get('uploadId')).toBe(sent[1].get('uploadId'))
})

it('retries a busy processing slot promptly instead of waiting a minute', async () => {
  vi.useFakeTimers()
  const { fetchMock } = setup([200])
  fetchMock
    .mockResolvedValueOnce(
      Response.json(
        { error: 'Another upload is processing; retry shortly' },
        { status: 429, headers: { 'Retry-After': '1' } },
      ),
    )
    .mockResolvedValueOnce(Response.json({ jobs: [] }))
    .mockResolvedValueOnce(
      Response.json({ eventId: 7, results: [{ status: 'success', photoId: 1 }] }),
    )
  const pending = uploadFile(new File(['image'], 'test.jpg'), {}, () => {})
  await vi.advanceTimersByTimeAsync(1499)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('rejects a reselected file whose retained chunk differs, without deleting resumable data', async () => {
  const { sent, fetchMock } = setup([])
  fetchMock.mockResolvedValueOnce(
    Response.json({
      exists: true,
      totalChunks: 1,
      chunks: [0],
      chunkHashes: { 0: '0'.repeat(64) },
    }),
  )
  await expect(
    uploadFile(new File(['different'], 'test.jpg'), {}, undefined, 'saved-id'),
  ).rejects.toThrow('differs from the original')
  expect(sent).toHaveLength(0)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('times out a hung resume lookup and retries without changing the upload ID', async () => {
  vi.useFakeTimers()
  const { fetchMock, sent } = setup([200])
  fetchMock
    .mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        }),
    )
    .mockResolvedValueOnce(Response.json({ exists: false, chunks: [] }))
    .mockResolvedValueOnce(
      Response.json({ eventId: 7, results: [{ status: 'success', photoId: 1 }] }),
    )
  const pending = uploadFile(new File(['image'], 'test.jpg'), {}, () => {}, 'stable-id')
  await vi.advanceTimersByTimeAsync(29999)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1001)
  await pending
  expect(fetchMock.mock.calls[0][0]).toBe(fetchMock.mock.calls[1][0])
  expect(sent[0].get('uploadId')).toBe('stable-id')
})

it('retries a stalled transfer but allows slow transfers that keep making progress', async () => {
  vi.useFakeTimers()
  setup([])
  const transfers: any[] = []
  class XHR {
    upload: any = {}
    status = 200
    responseText = '{"ok":true,"chunkIndex":0}'
    onload?: () => void
    onabort?: () => void
    open() {}
    send() {
      transfers.push(this)
    }
    abort() {
      this.onabort?.()
    }
  }
  vi.stubGlobal('XMLHttpRequest', XHR)
  const pending = uploadFile(new File(['image'], 'test.jpg'), {}, () => {})
  await vi.advanceTimersByTimeAsync(31000)
  expect(transfers).toHaveLength(2)
  for (let i = 1; i <= 4; i++) {
    await vi.advanceTimersByTimeAsync(20000)
    transfers[1].upload.onprogress({ loaded: i, total: 5, lengthComputable: true })
    expect(transfers).toHaveLength(2)
  }
  transfers[1].upload.onprogress({ loaded: 5, total: 5, lengthComputable: true })
  await vi.advanceTimersByTimeAsync(31000)
  expect(transfers).toHaveLength(2)
  transfers[1].onload()
  await pending
})

it('aborts an active chunk immediately without retrying or deleting saved chunks', async () => {
  const abort = vi.fn()
  const send = vi.fn()
  class XHR {
    upload = {}
    open = vi.fn()
    send = send
    abort = abort
  }
  vi.stubGlobal('XMLHttpRequest', XHR)
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()
  const pending = uploadFile(
    new File(['image'], 'test.jpg'),
    {},
    () => {},
    undefined,
    controller.signal,
  )
  const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
  controller.abort()
  await check
  expect(abort).toHaveBeenCalledOnce()
  expect(fetchMock).not.toHaveBeenCalled()
})

it('cancels a pending saved-status lookup without sending a chunk', async () => {
  const controller = new AbortController()
  const fetchMock = vi.fn(
    (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const pending = uploadFile(
    new File(['image'], 'test.jpg'),
    {},
    () => {},
    'saved-id',
    controller.signal,
  )
  const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  controller.abort()
  await check
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
})

it('interrupts retry backoff and never retries a canceled upload', async () => {
  vi.useFakeTimers()
  const { sent, fetchMock } = setup([503, 200])
  const controller = new AbortController()
  const pending = uploadFile(
    new File(['image'], 'test.jpg'),
    {},
    () => {},
    undefined,
    controller.signal,
  )
  const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(1)
  controller.abort()
  await check
  await vi.runAllTimersAsync()
  expect(sent).toHaveLength(1)
  expect(fetchMock).not.toHaveBeenCalled()
})

it.each([
  [401, { code: 'GATEWAY_AUTH_FAILED', error: 'Invalid gateway identity' }, 'upstream'],
  [403, { code: 'ACCESS_DENIED', error: 'Album owner permission required' }, 'permission'],
  [401, { code: 'SESSION_REQUIRED', error: 'Authentication required' }, 'authentication'],
])(
  'distinguishes access failures without deleting resumable chunks (%s, %j)',
  async (status, body, issue) => {
    const { fetchMock } = setup([])
    fetchMock.mockResolvedValueOnce(Response.json(body, { status }))
    await expect(
      uploadFile(new File(['x'], 'test.jpg'), {}, () => {}, 'saved'),
    ).rejects.toMatchObject({
      accessIssue: issue,
      authenticationRequired: issue === 'authentication',
      stopRetry: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  },
)

it('bounds completion recovery including Retry-After without deleting resumable chunks', async () => {
  vi.useFakeTimers()
  const { fetchMock } = setup([200])
  fetchMock.mockImplementation(
    async () =>
      new Response('{}', {
        status: 429,
        headers: { 'Retry-After': '600' },
      }),
  )
  const pending = uploadFile(new File(['image'], 'test.jpg'), {}, () => {})
  const assertion = expect(pending).rejects.toThrow('Upload recovery timed out')
  await vi.advanceTimersByTimeAsync(300_000)
  await assertion
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock.mock.calls[0][1].method).toBe('POST')
  expect(vi.getTimerCount()).toBe(0)
})

function busyChunkSetup(alwaysBusy = false) {
  const digest = createHash('sha256').update('image').digest()
  vi.stubGlobal('crypto', {
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    subtle: { digest: async () => digest },
  })
  let polls = 0
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/upload/chunk' && init.method === 'POST')
      return Response.json(
        { error: 'Chunk is already uploading; retry shortly' },
        { status: 429, headers: { 'Retry-After': '2' } },
      )
    if (url.startsWith('/api/upload/chunk?')) {
      polls++
      return Response.json({
        exists: true,
        totalChunks: 1,
        chunks: [],
        activeChunks: alwaysBusy || polls <= 5 ? [0] : [],
        chunkHashes: !alwaysBusy && polls > 5 ? { 0: digest.toString('hex') } : {},
      })
    }
    return Response.json({ eventId: 7, results: [{ status: 'success', photoId: 1 }] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
it('waits through more than four busy checks and reuses the committed matching chunk without retransmitting', async () => {
  vi.useFakeTimers()
  const fetchMock = busyChunkSetup()
  const pending = uploadFile(new File(['image'], 'test.jpg'), {})
  await vi.advanceTimersByTimeAsync(60_000)
  await expect(pending).resolves.toEqual({
    eventId: 7,
    results: [{ status: 'success', photoId: 1 }],
  })
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) => url === '/api/upload/chunk' && init.method === 'POST',
    ),
  ).toHaveLength(1)
  expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/upload/chunk?'))).toHaveLength(
    6,
  )
  expect(vi.getTimerCount()).toBe(0)
})
it('cancels busy-chunk polling without deleting saved chunks', async () => {
  vi.useFakeTimers()
  const fetchMock = busyChunkSetup(true)
  const controller = new AbortController()
  const pending = uploadFile(
    new File(['image'], 'test.jpg'),
    {},
    undefined,
    undefined,
    controller.signal,
  )
  const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(8000)
  controller.abort()
  await check
  expect(fetchMock.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
it('bounds an abandoned active chunk and retains it for later resume', async () => {
  vi.useFakeTimers()
  const fetchMock = busyChunkSetup(true)
  const pending = uploadFile(new File(['image'], 'test.jpg'), {})
  const check = expect(pending).rejects.toThrow('Upload recovery timed out')
  await vi.advanceTimersByTimeAsync(300_000)
  await check
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/upload/chunk')).toHaveLength(1)
  expect(fetchMock.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
it('rejects a different committed chunk without deleting it', async () => {
  vi.useFakeTimers()
  const fetchMock = busyChunkSetup()
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: 'Chunk is already uploading; retry shortly' }, { status: 429 }),
  )
  fetchMock.mockResolvedValueOnce(
    Response.json({
      exists: true,
      totalChunks: 1,
      chunks: [0],
      chunkHashes: { 0: '0'.repeat(64) },
      activeChunks: [],
    }),
  )
  const pending = uploadFile(new File(['image'], 'test.jpg'), {})
  const check = expect(pending).rejects.toMatchObject({ stopRetry: true })
  await vi.advanceTimersByTimeAsync(3000)
  await check
  expect(fetchMock.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(false)
})
it('resends the same chunk only after the previous reservation is no longer active', async () => {
  vi.useFakeTimers()
  const fetchMock = busyChunkSetup()
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: 'Chunk is already uploading; retry shortly' }, { status: 429 }),
  )
  fetchMock.mockResolvedValueOnce(
    Response.json({ exists: true, totalChunks: 1, chunks: [], chunkHashes: {}, activeChunks: [] }),
  )
  fetchMock.mockResolvedValueOnce(Response.json({ ok: true, chunkIndex: 0 }))
  const pending = uploadFile(new File(['image'], 'test.jpg'), {})
  await vi.advanceTimersByTimeAsync(3000)
  await expect(pending).resolves.toEqual({
    eventId: 7,
    results: [{ status: 'success', photoId: 1 }],
  })
  const sends = fetchMock.mock.calls.filter(([url]) => url === '/api/upload/chunk')
  expect(sends).toHaveLength(2)
  expect(sends[1][1].body).toBe(sends[0][1].body)
})

it.each(['done', 'queued', 'processing'])(
  'reconciles a lost completion response from a %s job',
  async (state) => {
    const { fetchMock, sent } = setup([200])
    const result = { eventId: 3, results: [{ status: 'success', photoId: 7 }] }
    let id: string
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === '/api/upload/complete') {
        id = JSON.parse(init.body as string).uploadId
        throw new TypeError('Connection lost after commit')
      }
      expect(url).toBe('/api/upload/status')
      expect(JSON.parse(init.body as string).uploadIds).toEqual([id])
      return Response.json({
        jobs: [{ uploadId: id, state, result: state === 'done' ? result : null }],
      })
    })
    const response = await uploadFile(new File(['photo'], 'test.jpg'), {}, () => {})
    expect(response).toEqual(state === 'done' ? result : { queued: true, uploadId: id! })
    expect(sent).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  },
)

it('checks durable status after 30 seconds instead of holding a completion slot for five minutes', async () => {
  vi.useFakeTimers()
  const { fetchMock } = setup([200])
  let id: string
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    if (url === '/api/upload/complete') {
      id = JSON.parse(init.body as string).uploadId
      return new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      )
    }
    return Promise.resolve(Response.json({ jobs: [{ uploadId: id, state: 'queued' }] }))
  })
  const pending = uploadFile(new File(['photo'], 'test.jpg'), {}, () => {})
  await vi.advanceTimersByTimeAsync(30_001)
  await expect(pending).resolves.toEqual({ queued: true, uploadId: id! })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('does not claim success when reconciliation denies access', async () => {
  const { fetchMock } = setup([200])
  fetchMock.mockRejectedValueOnce(new TypeError('Lost response'))
  fetchMock.mockResolvedValueOnce(Response.json({ code: 'ACCESS_DENIED' }, { status: 403 }))
  await expect(uploadFile(new File(['photo'], 'test.jpg'), {}, () => {})).rejects.toMatchObject({
    accessIssue: 'permission',
  })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it.each(['status', 'retry'] as const)(
  'cleanup aborts a pending durable %s request without retrying or deleting accepted work',
  async (operation) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const pending =
      operation === 'status'
        ? checkUploadJobs(['stable-upload'], controller.signal)
        : retryQueuedUpload('stable-upload', controller.signal)
    const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      operation === 'status' ? '/api/upload/status' : '/api/upload/complete',
    )
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual(
      operation === 'status'
        ? { uploadIds: ['stable-upload'] }
        : { uploadId: 'stable-upload', retryOnly: true, queuedProcessing: true },
    )
    controller.abort()
    await check
    await vi.advanceTimersByTimeAsync(300_001)
    expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  },
)
