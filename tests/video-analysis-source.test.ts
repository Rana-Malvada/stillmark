import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ one: vi.fn(), url: vi.fn(), fetch: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgQueryOne: m.one }))
vi.mock('@/lib/media/image-urls', () => ({ getPresignedUrl: m.url }))
import { preparedAnalysisSource } from '@/lib/video/video-analysis-source'

const r = (name: string) => ({ name, stage_path: `display/video/abc123/${name}/playback.mp4` })
function probeResponse(status = 206, range: string | null = 'bytes 0-0/1000', length = '1') {
  const cancel = vi.fn()
  const pull = vi.fn()
  const body = new ReadableStream({ cancel, pull }, { highWaterMark: 0 })
  const headers = new Headers({ 'content-length': length })
  if (range !== null) headers.set('content-range', range)
  return { response: new Response(body, { status, headers }), cancel, pull }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', m.fetch)
  m.url.mockImplementation(async (p) => `https://example.com/${p}`)
  m.fetch.mockImplementation(async () => probeResponse().response)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it('uses the GET signature with a one-byte range and cancels without reading the video', async () => {
  m.one.mockResolvedValue({ renditions: [r('720')] })
  const probe = probeResponse(206, 'bytes 0-0/13000000')
  // Reproduces the production behavior: this signed GET URL rejects HEAD.
  m.fetch.mockImplementation(async (_url, options) =>
    options.method === 'HEAD' ? new Response(null, { status: 403 }) : probe.response,
  )
  expect(await preparedAnalysisSource(1, 'originals/a')).toEqual({
    path: r('720').stage_path,
    bytes: 13000000,
  })
  expect(m.fetch).toHaveBeenCalledWith(`https://example.com/${r('720').stage_path}`, {
    method: 'GET',
    headers: { Range: 'bytes=0-0' },
    cache: 'no-store',
    redirect: 'error',
    signal: expect.any(AbortSignal),
  })
  expect(probe.cancel).toHaveBeenCalledOnce()
  expect(probe.pull).not.toHaveBeenCalled()
})
it('prefers 720 even when 1080 comes first', async () => {
  m.one.mockResolvedValue({ renditions: [r('1080'), r('720')] })
  expect(await preparedAnalysisSource(1, 'originals/a')).toEqual({
    path: r('720').stage_path,
    bytes: 1000,
  })
})
it('uses 1080 when 720 is absent', async () => {
  m.one.mockResolvedValue({ renditions: [r('1080')] })
  expect((await preparedAnalysisSource(1, 'originals/a'))?.path).toBe(r('1080').stage_path)
})
it('falls back when conversion has not completed', async () => {
  m.one.mockResolvedValue(null)
  expect(await preparedAnalysisSource(1, 'originals/a')).toBeNull()
  expect(m.fetch).not.toHaveBeenCalled()
  expect(m.one.mock.calls[0][0]).toContain("status='ready'")
  expect(m.one.mock.calls[0][0]).toContain('format_version=2')
  expect(m.one.mock.calls[0][1]).toEqual([1, 'originals/a'])
})
it('skips missing objects and oversized copies', async () => {
  m.one.mockResolvedValue({ renditions: [r('720'), r('1080')] })
  m.fetch
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(probeResponse(206, 'bytes 0-0/200000000').response)
  expect(await preparedAnalysisSource(1, 'originals/a')).toBeNull()
})
it('rejects a server that ignores Range and cancels its full response without reading it', async () => {
  m.one.mockResolvedValue({ renditions: [r('720')] })
  const probe = probeResponse(200, null, '13000000')
  m.fetch.mockResolvedValue(probe.response)
  expect(await preparedAnalysisSource(1, 'originals/a')).toBeNull()
  expect(probe.cancel).toHaveBeenCalledOnce()
  expect(probe.pull).not.toHaveBeenCalled()
})
it.each([
  null,
  'bytes 0-0/*',
  'bytes 0-1/1000',
  'bytes 1-1/1000',
  'bytes */1000',
  'bytes 0-0/0',
  'bytes 0-0/-1',
  'bytes 0-0/1.5',
  'bytes 0-0/9007199254740993',
  'bytes 0-0/100000000',
])('rejects an invalid or over-budget Content-Range: %s', async (range) => {
  m.one.mockResolvedValue({ renditions: [r('720')] })
  const probe = probeResponse(206, range)
  m.fetch.mockResolvedValue(probe.response)
  expect(await preparedAnalysisSource(1, 'originals/a')).toBeNull()
  expect(probe.cancel).toHaveBeenCalledOnce()
  expect(probe.pull).not.toHaveBeenCalled()
})
it('accepts a rendition immediately below the existing 100 MB budget', async () => {
  m.one.mockResolvedValue({ renditions: [r('720')] })
  m.fetch.mockResolvedValue(probeResponse(206, 'bytes 0-0/99999999').response)
  expect((await preparedAnalysisSource(1, 'originals/a'))?.bytes).toBe(99999999)
})
it('cancels a rejected 720 probe before using the valid 1080 rendition', async () => {
  m.one.mockResolvedValue({ renditions: [r('720'), r('1080')] })
  const rejected = probeResponse(403, null)
  const accepted = probeResponse()
  m.fetch.mockResolvedValueOnce(rejected.response).mockImplementationOnce(async () => {
    expect(rejected.cancel).toHaveBeenCalledOnce()
    return accepted.response
  })
  expect((await preparedAnalysisSource(1, 'originals/a'))?.path).toBe(r('1080').stage_path)
  expect(accepted.cancel).toHaveBeenCalledOnce()
  expect(rejected.pull).not.toHaveBeenCalled()
  expect(accepted.pull).not.toHaveBeenCalled()
})
it('retains the 15-second storage timeout and falls back on an aborted probe', async () => {
  m.one.mockResolvedValue({ renditions: [r('720')] })
  const controller = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  m.fetch.mockImplementation(async (_url, options) => {
    expect(options.signal).toBe(controller.signal)
    controller.abort(new DOMException('Timed out', 'TimeoutError'))
    options.signal.throwIfAborted()
  })
  expect(await preparedAnalysisSource(1, 'originals/a')).toBeNull()
  expect(timeout).toHaveBeenCalledWith(15000)
})
it('never signs or fetches an unexpected prepared-object path', async () => {
  m.one.mockResolvedValue({
    renditions: [{ name: '720', stage_path: 'https://example.com/untrusted.mp4' }],
  })
  expect(await preparedAnalysisSource(1, 'originals/a')).toBeNull()
  expect(m.url).not.toHaveBeenCalled()
  expect(m.fetch).not.toHaveBeenCalled()
})
it('falls back on storage errors', async () => {
  m.one.mockResolvedValue({ renditions: [r('720')] })
  m.fetch.mockRejectedValue(new Error('unavailable'))
  expect(await preparedAnalysisSource(1, 'originals/a')).toBeNull()
})
