import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { deployment } from '../config/deployment.mjs'

const mocks = vi.hoisted(() => ({ token: vi.fn(), url: vi.fn(), fetch: vi.fn() }))
vi.mock('@/lib/snowflake', () => ({ getServiceToken: mocks.token }))
vi.mock('@/lib/media/image-urls', () => ({ getPresignedUrl: mocks.url }))
vi.mock('@/lib/snowflake/cortex-rest-costs', () => ({
  beginRestCost: vi.fn(async () => 'test-work'),
  finishRestCost: vi.fn(async () => {}),
}))
import { beginRestCost, finishRestCost } from '@/lib/snowflake/cortex-rest-costs'
import { describePhoto } from '@/lib/snowflake/cortex-photo'
import { storageByteCache } from '@/lib/snowflake/storage-byte-cache'

let jpeg: Buffer
beforeEach(async () => {
  storageByteCache.clear()
  vi.resetAllMocks()
  vi.mocked(beginRestCost).mockResolvedValue('00000000-0000-0000-0000-000000000001')
  vi.stubGlobal('fetch', mocks.fetch)
  vi.stubEnv('SNOWFLAKE_CORTEX_TOKEN', '')
  vi.stubEnv('SNOWFLAKE_HOST', '')
  mocks.token.mockReturnValue('runtime-test-token')
  mocks.url.mockResolvedValue(`https://${deployment.STORAGE_HOST}/image?signature=private`)
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
    .jpeg()
    .toBuffer()
  mocks.fetch.mockImplementation(async (url: string | URL) =>
    String(url).includes('/cortex/')
      ? Response.json({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"description":"Red image","tags":["red"]}' }],
        })
      : new Response(new Uint8Array(jpeg)),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
it('reuses local display bytes and prepared retry input without storage calls', async () => {
  storageByteCache.set('display:display/test.jpg', jpeg)
  await describePhoto('display/test.jpg', 'model', 'prompt')
  await describePhoto('display/test.jpg', 'model', 'prompt')
  expect(mocks.url).not.toHaveBeenCalled()
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(mocks.fetch.mock.calls.every(([url]) => String(url).includes('/cortex/'))).toBe(true)
  storageByteCache.clear() // another process or restart retains the original fallback
  await describePhoto('display/test.jpg', 'model', 'prompt')
  expect(mocks.url).toHaveBeenCalledTimes(1)
})
it('cached bytes cannot bypass path validation or provider authentication', async () => {
  storageByteCache.set('ai:display/../private.jpg', jpeg)
  await expect(describePhoto('display/../private.jpg', 'model', 'prompt')).rejects.toThrow(
    'display image',
  )
  storageByteCache.set('ai:display/test.jpg', jpeg)
  mocks.token.mockReturnValue('')
  await expect(describePhoto('display/test.jpg', 'model', 'prompt')).rejects.toThrow(
    'authentication',
  )
  expect(mocks.fetch).not.toHaveBeenCalled()
})
it('sends image bytes and the existing prompt to Cortex with fresh runtime credentials', async () => {
  const raw = await describePhoto('display/test.jpg', 'claude-haiku-4-5', 'Describe precisely')
  expect(JSON.parse(raw).description).toBe('Red image')
  const [url, init] = mocks.fetch.mock.calls[1]
  expect(url).toBe(`${deployment.SNOWFLAKE_API_ORIGIN}/api/v2/cortex/v1/messages`)
  expect(init.headers.Authorization).toBe('Bearer runtime-test-token')
  expect(init.redirect).toBe('error')
  const body = JSON.parse(init.body)
  expect(body.model).toBe('claude-haiku-4-5')
  expect(body.messages[0].content[1].text).toBe('Describe precisely')
  expect(body.messages[0].content[0].source.media_type).toBe('image/jpeg')
  expect(init.body).not.toContain('signature=')
  expect(init.body).not.toContain('warehouse')
  mocks.token.mockReturnValue('rotated-token')
  await describePhoto('display/test.jpg', 'claude-haiku-4-5', 'Describe')
  expect(mocks.fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer rotated-token')
})
it('uses the injected container host only with runtime credentials', async () => {
  vi.stubEnv('SNOWFLAKE_HOST', 'runtime-account.snowflakecomputing.com')
  await describePhoto('display/test.jpg', 'claude-haiku-4-5', 'Describe')
  expect(mocks.fetch.mock.calls[1][0]).toBe(
    'https://runtime-account.snowflakecomputing.com/api/v2/cortex/v1/messages',
  )
  mocks.token.mockReturnValue('')
  vi.stubEnv('SNOWFLAKE_CORTEX_TOKEN', 'local-test-token')
  await describePhoto('display/test.jpg', 'claude-haiku-4-5', 'Describe')
  expect(mocks.fetch.mock.calls[2][0]).toBe(
    `${deployment.SNOWFLAKE_API_ORIGIN}/api/v2/cortex/v1/messages`,
  )
})
it('fails closed without authentication before reading an image', async () => {
  mocks.token.mockReturnValue('')
  await expect(describePhoto('display/test.jpg', 'model', 'prompt')).rejects.toThrow(
    'authentication',
  )
  expect(mocks.fetch).not.toHaveBeenCalled()
})
it('rejects non-display paths and unexpected storage destinations', async () => {
  await expect(describePhoto('originals/test.jpg', 'model', 'prompt')).rejects.toThrow(
    'display image',
  )
  mocks.url.mockResolvedValue('https://example.com/private')
  await expect(describePhoto('display/test.jpg', 'model', 'prompt')).rejects.toThrow('storage host')
  expect(mocks.fetch).not.toHaveBeenCalled()
})
it('does not leak provider errors or fall back to SQL on rate limits', async () => {
  mocks.fetch
    .mockResolvedValueOnce(new Response(new Uint8Array(jpeg)))
    .mockResolvedValueOnce(new Response('secret-token and image data', { status: 429 }))
  await expect(describePhoto('display/test.jpg', 'model', 'prompt')).rejects.toThrow('HTTP 429')
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
})
it('rejects truncated and empty completions', async () => {
  mocks.fetch
    .mockResolvedValueOnce(new Response(new Uint8Array(jpeg)))
    .mockResolvedValueOnce(
      Response.json({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] }),
    )
  await expect(describePhoto('display/test.jpg', 'model', 'prompt')).rejects.toThrow('incomplete')
  mocks.fetch.mockResolvedValueOnce(Response.json({ stop_reason: 'end_turn', content: [] }))
  await expect(describePhoto('display/test.jpg', 'model', 'prompt')).rejects.toThrow(
    'no photo description',
  )
})
it('bounds the downloaded image even without a Content-Length header', async () => {
  mocks.fetch.mockResolvedValueOnce(new Response(new Uint8Array(16 * 1024 * 1024 + 1)))
  await expect(describePhoto('display/test.jpg', 'model', 'prompt')).rejects.toThrow('size limit')
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

it('records direct usage and excludes thinking from descriptions', async () => {
  const usage = { input_tokens: 100, output_tokens: 20 }
  mocks.fetch.mockResolvedValueOnce(new Response(new Uint8Array(jpeg))).mockResolvedValueOnce(
    Response.json(
      {
        stop_reason: 'end_turn',
        usage,
        content: [
          { type: 'thinking', thinking: { text: 'private reasoning' } },
          { type: 'text', text: 'actual description' },
        ],
      },
      { headers: { 'x-snowflake-request-id': 'request-123' } },
    ),
  )
  expect(await describePhoto('display/test.jpg', 'claude-haiku-4-5', 'Describe')).toBe(
    'actual description',
  )
  expect(finishRestCost).toHaveBeenCalledWith(
    expect.anything(),
    'claude-haiku-4-5',
    usage,
    'request-123',
  )
})
it('rejects HTTP 200 provider errors without exposing their contents', async () => {
  mocks.fetch
    .mockResolvedValueOnce(new Response(new Uint8Array(jpeg)))
    .mockResolvedValueOnce(Response.json({ code: '399504', message: 'private image data' }))
  await expect(describePhoto('display/test.jpg', 'claude-haiku-4-5', 'Describe')).rejects.toThrow(
    'incomplete',
  )
})

it('downloads images from the Snowflake runtime access point before inference', async () => {
  const host = 'example-runtime-access-point-s3alias.s3.us-east-2.amazonaws.com'
  expect(deployment.RUNTIME_STORAGE_HOST).toBe(host)
  mocks.url.mockResolvedValue(`https://${host}/display/test.jpg?signature=private`)
  await describePhoto('display/test.jpg', 'claude-haiku-4-5', 'Describe')
  expect(String(mocks.fetch.mock.calls[0][0])).toContain(host)
  expect(mocks.fetch.mock.calls[1][0]).toContain('/cortex/v1/messages')
})
it('rejects lookalike runtime hosts', async () => {
  mocks.url.mockResolvedValue(`https://${deployment.RUNTIME_STORAGE_HOST}.example.com/image`)
  await expect(describePhoto('display/test.jpg', 'model', 'prompt')).rejects.toThrow('storage host')
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('limits image preparation to three while eight inference requests wait independently', async () => {
  const downloads: Array<() => void> = []
  const inferences: Array<() => void> = []
  let preparing = 0
  let peakPreparation = 0
  mocks.fetch.mockImplementation(async (url: string | URL) => {
    if (String(url).includes('/cortex/')) {
      await new Promise<void>((resolve) => inferences.push(resolve))
      return Response.json({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'description' }],
      })
    }
    preparing++
    peakPreparation = Math.max(peakPreparation, preparing)
    await new Promise<void>((resolve) => downloads.push(resolve))
    preparing--
    return new Response(new Uint8Array(jpeg))
  })
  const requests = Array.from({ length: 8 }, (_, i) =>
    describePhoto(`display/concurrent-${i}.jpg`, 'model', 'prompt'),
  )
  for (const count of [3, 3, 2]) {
    await vi.waitFor(() => expect(downloads).toHaveLength(count))
    expect(preparing).toBeLessThanOrEqual(3)
    downloads.splice(0).forEach((release) => release())
  }
  await vi.waitFor(() => expect(inferences).toHaveLength(8))
  expect(peakPreparation).toBe(3)
  inferences.splice(0).forEach((release) => release())
  expect(await Promise.all(requests)).toHaveLength(8)
})
