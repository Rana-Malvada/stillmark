import { expect, it, vi } from 'vitest'
import {
  PREVIEW_BYTE_LIMIT,
  PREVIEW_CONTENT_TYPE,
  type PreviewBatchEvent,
  previewBatchStream,
  previewPath,
  readPreviewBatch,
} from '../public/preview-batch.mjs'
import { batchPreviewPath, createPreviewBatchClient } from '../public/preview-batch-client.mjs'

const response = (stream: ReadableStream) =>
  new Response(stream, { headers: { 'Content-Type': PREVIEW_CONTENT_TYPE } })
const image = (value: string) => new Response(value, { headers: { 'Content-Type': 'image/jpeg' } })
it('observes separate header/body durations and exact frame bytes without media identifiers', async () => {
  let now = 100
  let pulls = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const events: PreviewBatchEvent[] = []
  try {
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls++ === 0) {
            now = 160
            controller.enqueue(new TextEncoder().encode('hello'))
          } else {
            now = 190
            controller.close()
          }
        },
      },
      { highWaterMark: 0 },
    )
    const wire = await response(
      previewBatchStream(
        ['thumbnails/private.jpg'],
        async () => {
          now = 125
          return new Response(source, { headers: { 'Content-Type': 'image/jpeg' } })
        },
        undefined,
        (event) => {
          events.push(event)
        },
      ),
    ).arrayBuffer()
    expect(events.map((event) => event.type)).toEqual([
      'item-start',
      'item-headers',
      'item-body',
      'item-frame',
      'complete',
    ])
    expect(events[1]).toEqual({
      type: 'item-headers',
      index: 0,
      status: 200,
      bytes: 0,
      elapsedMs: 25,
      headerMs: 25,
    })
    expect(events[2]).toEqual({
      type: 'item-body',
      index: 0,
      status: 200,
      bytes: 5,
      elapsedMs: 90,
      headerMs: 25,
      bodyMs: 65,
    })
    expect(events[3].bytes).toBe(wire.byteLength)
    expect(events[4]).toEqual({
      type: 'complete',
      index: -1,
      status: 200,
      bytes: wire.byteLength,
      elapsedMs: 90,
    })
    for (const event of events)
      for (const [key, value] of Object.entries(event)) {
        expect(['type', 'index', 'status', 'bytes', 'elapsedMs', 'headerMs', 'bodyMs']).toContain(
          key,
        )
        if (key !== 'type') expect(Number.isFinite(value)).toBe(true)
      }
  } finally {
    clock.mockRestore()
  }
})

it('includes rejected-body cancellation cleanup and reports bytes consumed before the limit', async () => {
  let now = 0
  let cancelled = false
  let bodyObservedAfterCancellation = false
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const events: PreviewBatchEvent[] = []
  try {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(PREVIEW_BYTE_LIMIT + 1))
      },
      async cancel() {
        now = 80
        await Promise.resolve()
        now = 110
        cancelled = true
      },
    })
    const statuses: number[] = []
    await readPreviewBatch(
      response(
        previewBatchStream(
          ['private-selector'],
          async () => {
            now = 20
            return new Response(source, { headers: { 'Content-Type': 'image/jpeg' } })
          },
          undefined,
          (event) => {
            if (event.type === 'item-body') bodyObservedAfterCancellation = cancelled
            events.push(event)
          },
        ),
      ),
      1,
      (_, blob, status) => {
        expect(blob).toBeNull()
        statuses.push(status)
      },
    )
    expect(bodyObservedAfterCancellation).toBe(true)
    expect(statuses).toEqual([502])
    expect(events.find((event) => event.type === 'item-body')).toMatchObject({
      status: 502,
      bytes: PREVIEW_BYTE_LIMIT + 1,
      headerMs: 20,
      bodyMs: 90,
      elapsedMs: 110,
    })
    expect(events.at(-1)?.status).toBe(200) // The error frame was delivered successfully.
  } finally {
    clock.mockRestore()
  }
})

it('isolates throwing and rejecting observers while preserving frames and reuse outcomes', async () => {
  const produce = (item: string | null) =>
    Promise.resolve(
      item === 'reuse' ? new Response(null, { status: 304 }) : item ? image(item) : null,
    )
  const expected = await response(
    previewBatchStream(['a', 'reuse', null], produce, undefined),
  ).arrayBuffer()
  for (const asynchronous of [false, true]) {
    const events: PreviewBatchEvent[] = []
    const actual = await response(
      previewBatchStream(['a', 'reuse', null], produce, undefined, (event) => {
        events.push(event)
        if (asynchronous) return Promise.reject(Error('observer failure'))
        throw Error('observer failure')
      }),
    ).arrayBuffer()
    expect(new Uint8Array(actual)).toEqual(new Uint8Array(expected))
    expect(
      events
        .filter((event) => event.type === 'item-body')
        .map((event) => event.status)
        .sort(),
    ).toEqual([200, 304, 404])
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1)
  }
})

it('observes failed fetches without exposing exception text and does no clock work when absent', async () => {
  const events: PreviewBatchEvent[] = []
  await readPreviewBatch(
    response(
      previewBatchStream(
        ['private-selector'],
        async () => {
          throw Error('private signed URL or credential')
        },
        undefined,
        (event) => {
          events.push(event)
        },
      ),
    ),
    1,
    (_, blob, status) => {
      expect(blob).toBeNull()
      expect(status).toBe(502)
    },
  )
  expect(events.map((event) => event.type)).toEqual([
    'item-start',
    'item-body',
    'item-frame',
    'complete',
  ])
  expect(events[1]).toMatchObject({ status: 502, bytes: 0, bodyMs: 0 })
  expect(JSON.stringify(events)).not.toContain('private')
  const clock = vi.spyOn(Date, 'now')
  try {
    await response(previewBatchStream(['a'], async () => image('a'), undefined)).arrayBuffer()
    expect(clock).not.toHaveBeenCalled()
  } finally {
    clock.mockRestore()
  }
})

it('reports cancellation once after the four active fetches settle, without starting more items', async () => {
  const events: PreviewBatchEvent[] = []
  const parent = new AbortController()
  const started: number[] = []
  let releaseStarted!: () => void
  const active = new Promise<void>((resolve) => {
    releaseStarted = resolve
  })
  let releaseComplete!: () => void
  const complete = new Promise<void>((resolve) => {
    releaseComplete = resolve
  })
  const stream = previewBatchStream(
    Array.from({ length: 8 }, (_, i) => String(i)),
    (item, signal) =>
      new Promise<Response>((_, reject) => {
        started.push(Number(item))
        signal.addEventListener('abort', () => reject(Error('private cancellation reason')), {
          once: true,
        })
        if (started.length === 4) releaseStarted()
      }),
    parent.signal,
    (event) => {
      events.push(event)
      if (event.type === 'complete') releaseComplete()
    },
  )
  const reader = stream.getReader()
  await active
  const cancelled = reader.cancel()
  parent.abort()
  await cancelled
  await complete
  expect(started).toEqual([0, 1, 2, 3])
  expect(events.filter((event) => event.type === 'item-frame')).toHaveLength(0)
  expect(events.filter((event) => event.type === 'item-body')).toHaveLength(4)
  expect(
    events.filter((event) => event.type === 'item-body').every((event) => event.status === 499),
  ).toBe(true)
  expect(events.filter((event) => event.type === 'complete')).toEqual([
    expect.objectContaining({ index: -1, status: 499, bytes: 0 }),
  ])
  expect(JSON.stringify(events)).not.toContain('private')
})

it('streams completed items first, with correct indexes and independent failure', async () => {
  let finish!: (r: Response) => void
  const slow = new Promise<Response>((resolve) => (finish = resolve))
  const received: number[] = []
  const observedFrames: number[] = []
  const pending = readPreviewBatch(
    response(
      previewBatchStream(
        ['slow', 'fast', null],
        async (item) => (item === 'slow' ? slow : item ? image('fast') : null),
        undefined,
        (event) => {
          if (event.type === 'item-frame') observedFrames.push(event.index)
        },
      ),
    ),
    3,
    (i: number, blob: Blob | null) => {
      received.push(i)
      if (i === 1) {
        expect(blob?.size).toBe(4)
        finish(image('slow'))
      }
      if (i === 2) expect(blob).toBeNull()
    },
  )
  await pending
  expect(received.indexOf(1)).toBeLessThan(received.indexOf(0))
  expect(new Set(received).size).toBe(3)
  expect(observedFrames).toEqual(received)
})
it('caps streamed bytes even when storage omits content-length', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(PREVIEW_BYTE_LIMIT + 1))
    },
    cancel() {
      cancelled = true
    },
  })
  let got: Blob | null | undefined
  await readPreviewBatch(
    response(
      previewBatchStream(
        ['large'],
        async () => new Response(stream, { headers: { 'Content-Type': 'image/jpeg' } }),
        undefined,
      ),
    ),
    1,
    (_, blob) => (got = blob),
  )
  expect(got).toBeNull()
  expect(cancelled).toBe(true)
})
it('parses fragmented frames and rejects truncation', async () => {
  const bytes = new Uint8Array(
    await response(previewBatchStream(['a'], async () => image('hello'), undefined)).arrayBuffer(),
  )
  const fragment = new ReadableStream({
    start(c) {
      for (const b of bytes) c.enqueue(new Uint8Array([b]))
      c.close()
    },
  })
  let received = ''
  const blobs: Blob[] = []
  await readPreviewBatch(response(fragment), 1, (_, blob) => {
    if (blob) blobs.push(blob)
  })
  received = await blobs[0].text()
  expect(received).toBe('hello')
  await expect(
    readPreviewBatch(
      new Response(bytes.slice(0, -1), { headers: { 'Content-Type': PREVIEW_CONTENT_TYPE } }),
      1,
      () => {},
    ),
  ).rejects.toThrow('Incomplete')
})
it('rejects duplicate frames and non-image responses', async () => {
  const bytes = new Uint8Array(
    await response(previewBatchStream(['a'], async () => image('hello'), undefined)).arrayBuffer(),
  )
  const both = new Uint8Array(bytes.length * 2)
  both.set(bytes)
  both.set(bytes, bytes.length)
  await expect(
    readPreviewBatch(
      new Response(both, { headers: { 'Content-Type': PREVIEW_CONTENT_TYPE } }),
      2,
      () => {},
    ),
  ).rejects.toThrow('Invalid')
  await expect(readPreviewBatch(new Response('<html>'), 1, () => {})).rejects.toThrow('unavailable')
})
it('groups eight callers into one request and resolves images without URLs', async () => {
  let calls = 0
  const client = createPreviewBatchClient({
    setTimeout,
    clearTimeout,
    fetch: async (_: string, options: RequestInit) => {
      calls++
      const { paths } = JSON.parse(options.body as string)
      return response(
        previewBatchStream(paths, async (path) => image(path!), options.signal ?? undefined),
      )
    },
  })
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      client(`thumbnails/${i}.jpg`, new AbortController().signal),
    ),
  )
  expect(calls).toBe(1)
  expect(await results[5].text()).toBe('thumbnails/5.jpg')
})
it('only opts in same-origin thumbnail selectors; shares, originals and retry use fallback', () => {
  const origin = 'https://photos.test'
  expect(batchPreviewPath('/api/images?path=thumbnails/a.jpg&batch=1', origin)).toBe(
    'thumbnails/a.jpg',
  )
  for (const src of [
    '/api/images?path=originals/a.jpg&batch=1',
    '/share/token/media/1?batch=1',
    '/api/images?path=thumbnails/a.jpg&batch=1&download=1',
    'https://evil.test/api/images?path=thumbnails/a.jpg&batch=1',
    '/api/images?path=thumbnails/a.jpg&batch=1&thumbnailRetry=1',
  ])
    expect(batchPreviewPath(src, origin)).toBeNull()
  expect(previewPath('thumbnails/../originals/a.jpg')).toBe(false)
})
it('cancelling one consumer preserves other images', async () => {
  let release!: () => void
  const wait = new Promise<void>((r) => (release = r))
  let started!: () => void
  const startedRequest = new Promise<void>((resolve) => {
    started = resolve
  })
  let transport: AbortSignal | undefined
  const client = createPreviewBatchClient({
    setTimeout,
    clearTimeout,
    fetch: async (_: string, options: RequestInit) => {
      transport = options.signal as AbortSignal
      started()
      await wait
      return response(previewBatchStream(['a', 'b'], async (path) => image(path!), transport))
    },
  })
  const a = new AbortController()
  const b = new AbortController()
  const first = client('thumbnails/a.jpg', a.signal).catch(() => null)
  const second = client('thumbnails/b.jpg', b.signal)
  await startedRequest
  a.abort()
  release()
  expect(await first).toBeNull()
  expect(await (await second).text()).toBe('b')
  expect(transport?.aborted).toBe(false)
})
it('recognizes stage octet-stream images by signature and rejects mismatched or non-image bytes', async () => {
  const cases = [
    ['thumbnails/a.jpg', [255, 216, 255, 224], 'image/jpeg'],
    ['thumbnails/a.png', [137, 80, 78, 71, 13, 10, 26, 10], 'image/png'],
    ['faces/a.webp', [...new TextEncoder().encode('RIFF0000WEBP')], 'image/webp'],
    ['thumbnails/a.jpg', [...new TextEncoder().encode('<html>denied</html>')], null],
    ['thumbnails/a.png', [255, 216, 255, 224], null],
  ] as const
  for (const [path, bytes, type] of cases) {
    let blob: Blob | null = null
    await readPreviewBatch(
      response(
        previewBatchStream(
          [path],
          async () =>
            new Response(new Uint8Array(bytes), {
              headers: { 'Content-Type': 'application/octet-stream' },
            }),
          undefined,
        ),
      ),
      1,
      (_, value) => {
        blob = value
      },
    )
    expect((blob as Blob | null)?.type ?? null).toBe(type)
  }
})
it('reuses real grant-free batch bytes only after live authorization and clears on logout', async () => {
  let downloads = 0
  let requests = 0
  let allowed = true
  let logout!: () => void
  const client = createPreviewBatchClient({
    setTimeout,
    clearTimeout,
    addEventListener: (_: string, fn: () => void) => {
      logout = fn
    },
    fetch: async (_: string, options: RequestInit) => {
      requests++
      const { paths, cached = [] } = JSON.parse(options.body as string)
      return response(
        previewBatchStream(
          paths.map((p: string) => (allowed ? p : null)),
          async (path) => {
            if (!path) return null
            if (cached.includes(path)) return new Response(null, { status: 304 })
            downloads++
            return image(path)
          },
          options.signal ?? undefined,
        ),
      )
    },
  })
  const path = 'thumbnails/legacy-album/image.jpg'
  const load = () => client(path, new AbortController().signal)
  expect(await (await load()).text()).toBe(path)
  expect(await (await load()).text()).toBe(path)
  expect(requests).toBe(2)
  expect(downloads).toBe(1)
  allowed = false
  await expect(load()).rejects.toThrow()
  allowed = true
  await load()
  expect(downloads).toBe(2)
  logout()
  await load()
  expect(downloads).toBe(3)
})
it('fills three bounded batches for a 24-thumbnail visible window', async () => {
  const sizes: number[] = []
  const client = createPreviewBatchClient({
    setTimeout,
    clearTimeout,
    fetch: async (_: string, options: RequestInit) => {
      const { paths } = JSON.parse(options.body as string)
      sizes.push(paths.length)
      return response(
        previewBatchStream(paths, async (p) => image(p!), options.signal ?? undefined),
      )
    },
  })
  await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      client(`thumbnails/${i}.jpg`, new AbortController().signal),
    ),
  )
  expect(sizes).toEqual([8, 8, 8])
})

it.each(['/api/faces/batch', '/api/trash/batch', '/share/example/previews'])(
  'versioned reuse at %s rechecks access and refetches changed bytes',
  async (endpoint) => {
    let version = 'a'.repeat(64)
    let allowed = true
    let downloads = 0
    let logout!: () => void
    const client = createPreviewBatchClient(
      {
        setTimeout,
        clearTimeout,
        addEventListener: (_: string, fn: () => void) => {
          logout = fn
        },
        fetch: async (_: string, init: RequestInit) => {
          const { ids, cached = [] } = JSON.parse(init.body as string)
          return new Response(
            previewBatchStream(
              ids.map(() => (allowed ? 'thumbnails/a.jpg' : null)),
              async (path) => {
                if (!path) return null
                if (
                  cached.some(
                    (c: { id: number; version: string }) =>
                      c.id === ids[0] && c.version === version,
                  )
                )
                  return new Response(null, { status: 304 })
                downloads++
                return image(version)
              },
              new AbortController().signal,
            ),
            {
              headers: {
                'Content-Type': PREVIEW_CONTENT_TYPE,
                'x-preview-versions': JSON.stringify([allowed ? version : null]),
              },
            },
          )
        },
      },
      endpoint,
      'ids',
    )
    const load = () => client(1, new AbortController().signal)
    expect(await (await load()).text()).toBe(version)
    await load()
    expect(downloads).toBe(1)
    version = 'b'.repeat(64)
    expect(await (await load()).text()).toBe(version)
    expect(downloads).toBe(2)
    allowed = false
    await expect(load()).rejects.toThrow()
    allowed = true
    await load()
    expect(downloads).toBe(3)
    logout()
    await load()
    expect(downloads).toBe(4)
  },
)
