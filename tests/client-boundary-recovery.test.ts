import { afterEach, expect, it, vi } from 'vitest'
import {
  isAccount,
  isAccountSaved,
  isAuthResponse,
  isLogoutDestination,
} from '@/lib/identity/account-response'
import { loadOriginal } from '@/lib/original-transfer'
import { isUploadCompletion, isUploadJobs, isUploadResume } from '@/lib/upload/upload-response'
import { isSharedDetails, isSharedPage, sharedJson } from '../public/shared-album-transport.mjs'

const id = '11111111-1111-4111-8111-111111111111'
const result = { eventId: 7, results: [{ status: 'success', photoId: 8 }] }
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('validates account authority, allowances and logout destinations before updating client state', () => {
  expect(isAccount({ displayName: 'Local', publicAccount: false })).toBe(true)
  expect(
    isAccount({
      displayName: 'User',
      email: 'u@example.test',
      publicAccount: true,
      uploadLimit: 10,
      uploadsUsed: 2,
    }),
  ).toBe(true)
  expect(
    isAccount({
      displayName: 'User',
      publicAccount: true,
      uploadLimit: 'unlimited',
      uploadsUsed: 2,
    }),
  ).toBe(false)
  expect(isAccountSaved({ ok: false })).toBe(false)
  const auth = {
    authenticated: true,
    username: 'ALICE',
    role: 'viewer',
    canManagePersonal: true,
    canManageAccess: false,
    mainAdmin: false,
  }
  expect(isAuthResponse(auth)).toBe(true)
  expect(isAuthResponse({ ...auth, mainAdmin: 'true' })).toBe(false)
  expect(isAuthResponse({ ...auth, role: 'unknown' })).toBe(false)
  expect(isAuthResponse({ ...auth, role: ['admin'] })).toBe(false)
  expect(isLogoutDestination({ url: 'https://login.example.test/logout' })).toBe(true)
  expect(isLogoutDestination({ url: 'https://user:pass@login.example.test/logout' })).toBe(false)
  expect(isLogoutDestination({ url: 'javascript:alert(1)' })).toBe(false)
})
it('rejects malformed nested upload data atomically, including partially valid status groups', () => {
  expect(isUploadCompletion(result)).toBe(true)
  expect(isUploadCompletion({ queued: true, uploadId: id })).toBe(true)
  for (const bad of [
    { queued: true, uploadId: 'other' },
    { ...result, eventId: '7' },
    { ...result, results: [{ status: 'success', photoId: -1 }] },
    { ...result, results: [{ status: 'anything', photoId: 8 }] },
    { ...result, results: {} },
    { ...result, results: [{ status: ['success'], photoId: 8 }] },
  ])
    expect(isUploadCompletion(bad)).toBe(false)
  const job = { uploadId: id, state: 'done', result }
  expect(isUploadJobs({ jobs: [job] })).toBe(true)
  for (const bad of [
    { jobs: [job, { uploadId: id, state: 'queued' }] },
    { jobs: [job, { uploadId: 'bad', state: 'queued' }] },
    { jobs: [{ ...job, state: 'unknown' }] },
    { jobs: [{ ...job, state: ['done'], result: null }] },
    { jobs: [{ ...job, result: null }] },
  ])
    expect(isUploadJobs(bad)).toBe(false)
  expect(
    isUploadResume({
      exists: true,
      chunks: [0],
      totalChunks: 1,
      chunkHashes: { 0: 'a'.repeat(64) },
    }),
  ).toBe(true)
  expect(isUploadResume({ exists: true, chunks: [1], totalChunks: 1 })).toBe(false)
  expect(isUploadResume({ exists: true, chunks: [0, 0], totalChunks: 1 })).toBe(false)
})
it.each(['headers', 'body'])(
  'bounds original %s stalls and permits a fresh retry',
  async (mode) => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() =>
          mode === 'headers'
            ? new Promise(() => {})
            : Promise.resolve(
                new Response(new ReadableStream({ start() {} }), {
                  headers: { 'Content-Type': 'video/mp4' },
                }),
              ),
        )
        .mockResolvedValueOnce(
          new Response('original bytes', { headers: { 'Content-Type': 'video/mp4' } }),
        ),
    )
    const pending = loadOriginal('/original', new AbortController().signal, {
      idleMs: 50,
      timeoutMs: 200,
    })
    const check = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(50)
    await check
    expect(await (await loadOriginal('/original', new AbortController().signal)).text()).toBe(
      'original bytes',
    )
  },
)
it('retains original bytes through a slow progressing transfer and enforces its total budget', async () => {
  vi.useFakeTimers()
  let stream!: ReadableStreamDefaultController<Uint8Array>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            stream = c
          },
        }),
        { headers: { 'Content-Type': 'video/mp4' } },
      ),
    ),
  )
  const pending = loadOriginal('/original', new AbortController().signal, {
    idleMs: 50,
    timeoutMs: 200,
  })
  for (let n = 0; n < 4; n++) {
    await vi.advanceTimersByTimeAsync(40)
    stream.enqueue(new Uint8Array([n]))
  }
  stream.close()
  expect([...new Uint8Array(await (await pending).arrayBuffer())]).toEqual([0, 1, 2, 3])
  expect(vi.getTimerCount()).toBe(0)
})
it('cancels original preparation promptly even when the transport ignores abort', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  )
  const c = new AbortController()
  const pending = loadOriginal('/original', c.signal)
  c.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
})
it.each(['headers', 'body'])(
  'bounds shared JSON %s stalls and rejects malformed nested details',
  async (mode) => {
    vi.useFakeTimers()
    const fetcher = vi.fn(() =>
      mode === 'headers'
        ? new Promise(() => {})
        : Promise.resolve({ ok: true, json: () => new Promise(() => {}) }),
    )
    const pending = sharedJson('/share/token?photo=1', {}, isSharedDetails, 50, fetcher)
    const check = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(50)
    await check
    expect(
      isSharedDetails({
        details: {},
        people: [{ name: 'Person', box: { x: 0, y: 0, w: '1', h: 1 } }],
      }),
    ).toBe(false)
    expect(
      isSharedPage({
        items: [{ photo_id: '1', media_type: 'photo', source_filename: 'a' }],
        nextPage: null,
      }),
    ).toBe(false)
  },
)
