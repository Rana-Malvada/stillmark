import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { deployment } from '../config/deployment.mjs'

const mocks = vi.hoisted(() => ({ url: vi.fn(), fetch: vi.fn() }))
vi.mock('@/lib/snowflake', () => ({ getServiceToken: () => '' }))
vi.mock('@/lib/media/image-urls', () => ({ getPresignedUrl: mocks.url }))
vi.mock('@/lib/snowflake/cortex-rest-costs', () => ({
  beginRestCost: vi.fn(async () => '00000000-0000-0000-0000-000000000001'),
  finishRestCost: vi.fn(async () => {}),
  OPENAI_PRICING_VERSION: 'openai-usd-test',
}))
import { beginRestCost, finishRestCost } from '@/lib/snowflake/cortex-rest-costs'
import { describePhotoOpenAI, PhotoAiProviderUnavailable } from '@/lib/ai/openai-photo'
import { storageByteCache } from '@/lib/snowflake/storage-byte-cache'

const KEY = 'test-key-not-real'
const completed = (text = '{"description":"Red image","tags":["red"]}') => ({
  id: 'resp_1',
  status: 'completed',
  usage: { input_tokens: 900, output_tokens: 120 },
  output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'private reasoning' }] },
    { type: 'message', content: [{ type: 'output_text', text }] },
  ],
})
const hooks = () => ({ dispatched: vi.fn(), rateLimited: vi.fn(), received: vi.fn() })
let jpeg: Buffer
beforeEach(async () => {
  storageByteCache.clear()
  vi.resetAllMocks()
  vi.mocked(beginRestCost).mockResolvedValue('00000000-0000-0000-0000-000000000001')
  vi.stubGlobal('fetch', mocks.fetch)
  vi.stubEnv('SNOWFLAKE_SECRET_OPENAI_API_SECRET_STRING', KEY)
  mocks.url.mockResolvedValue(`https://${deployment.STORAGE_HOST}/image?signature=private`)
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
    .jpeg()
    .toBuffer()
  mocks.fetch.mockImplementation(async (url: string | URL) =>
    String(url).startsWith('https://api.openai.com/')
      ? Response.json(completed(), { headers: { 'x-request-id': 'req-123' } })
      : new Response(new Uint8Array(jpeg)),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
const request = () => mocks.fetch.mock.calls.find(([url]) => String(url).includes('openai.com'))!

it('sends the image and prompt only to OpenAI, asks for no retention, and records usage', async () => {
  const h = hooks()
  const raw = await describePhotoOpenAI('display/test.jpg', 'gpt-6.2-sol', 'Describe precisely', h)
  expect(JSON.parse(raw)).toEqual({ description: 'Red image', tags: ['red'] })
  const [url, init] = request()
  expect(url).toBe('https://api.openai.com/v1/responses')
  expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
  expect(init.redirect).toBe('error')
  const body = JSON.parse(init.body)
  expect(body).toMatchObject({ model: 'gpt-6.2-sol', store: false })
  expect(body.input[0].content[0].image_url).toMatch(/^data:image\/jpeg;base64,/)
  expect(body.input[0].content[1]).toEqual({ type: 'input_text', text: 'Describe precisely' })
  expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true })
  // Storage credentials and signed URLs never reach the provider.
  expect(init.body).not.toContain('signature=')
  expect(beginRestCost).toHaveBeenCalledWith('gpt-6.2-sol', 'openai-usd-test')
  expect(h.dispatched).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001')
  expect(h.received).toHaveBeenCalledWith(
    expect.objectContaining({ text: raw, requestId: 'req-123', model: 'gpt-6.2-sol' }),
  )
  expect(finishRestCost).toHaveBeenCalledWith(
    '00000000-0000-0000-0000-000000000001',
    'gpt-6.2-sol',
    { input_tokens: 900, output_tokens: 120 },
    'req-123',
  )
})

it('excludes reasoning from the description', async () => {
  expect(await describePhotoOpenAI('display/test.jpg', 'gpt-6.2-sol', 'p')).not.toContain(
    'private reasoning',
  )
})

it('is unavailable without a key, before reading the photo or recording a cost', async () => {
  vi.stubEnv('SNOWFLAKE_SECRET_OPENAI_API_SECRET_STRING', '')
  const error = await describePhotoOpenAI('display/test.jpg', 'gpt-6.2-sol', 'p').catch((e) => e)
  expect(error).toBeInstanceOf(PhotoAiProviderUnavailable)
  // The secret reader's message names file paths; none of it is passed on.
  expect(error.message).toBe('OpenAI authentication is unavailable')
  expect(mocks.fetch).not.toHaveBeenCalled()
  expect(beginRestCost).not.toHaveBeenCalled()
})

it.each([
  [429, { error: { code: 'credit_balance_exhausted', type: 'insufficient_quota' } }],
  [429, { error: { type: 'insufficient_quota' } }],
  [429, { error: { code: 'organization_spend_limit_exceeded' } }],
  [401, { error: { code: 'invalid_api_key', message: `Incorrect API key ${KEY}` } }],
  [403, {}],
])('releases the photo for another provider on HTTP %i %j', async (status, body) => {
  mocks.fetch
    .mockResolvedValueOnce(new Response(new Uint8Array(jpeg)))
    .mockResolvedValueOnce(Response.json(body, { status }))
  const h = hooks()
  const error = await describePhotoOpenAI('display/test.jpg', 'gpt-6.2-sol', 'p', h).catch((e) => e)
  expect(error).toBeInstanceOf(PhotoAiProviderUnavailable)
  expect(error.pause).toBe(true)
  expect(error.message).not.toContain(KEY)
  expect(h.rateLimited).toHaveBeenCalledOnce()
  expect(h.received).not.toHaveBeenCalled()
})

it.each([400, 404, 422])(
  'releases only this photo when the request is not accepted (HTTP %i)',
  async (status) => {
    mocks.fetch
      .mockResolvedValueOnce(new Response(new Uint8Array(jpeg)))
      .mockResolvedValueOnce(
        Response.json({ error: { message: 'private image data' } }, { status }),
      )
    const h = hooks()
    const error = await describePhotoOpenAI('display/test.jpg', 'gpt-6.2-sol', 'p', h).catch(
      (e) => e,
    )
    expect(error).toBeInstanceOf(PhotoAiProviderUnavailable)
    expect(error.pause).toBe(false)
    expect(error.message).not.toContain('private')
    expect(h.rateLimited).toHaveBeenCalledOnce()
  },
)

it('treats an ordinary rate limit as "try later", not as a reason to switch provider', async () => {
  mocks.fetch
    .mockResolvedValueOnce(new Response(new Uint8Array(jpeg)))
    .mockResolvedValueOnce(
      Response.json(
        { error: { type: 'rate_limit_error', code: 'slow_down' } },
        { status: 429, headers: { 'retry-after': '42' } },
      ),
    )
  const h = hooks()
  const error = await describePhotoOpenAI('display/test.jpg', 'gpt-6.2-sol', 'p', h).catch((e) => e)
  expect(error).not.toBeInstanceOf(PhotoAiProviderUnavailable)
  expect(error).toMatchObject({ status: 429, retryAfterSeconds: 42 })
  expect(h.rateLimited).toHaveBeenCalledOnce()
})

it('does not leak provider error text and does not release the photo on other failures', async () => {
  mocks.fetch
    .mockResolvedValueOnce(new Response(new Uint8Array(jpeg)))
    .mockResolvedValueOnce(new Response('secret image data', { status: 500 }))
  const h = hooks()
  await expect(describePhotoOpenAI('display/test.jpg', 'gpt-6.2-sol', 'p', h)).rejects.toThrow(
    /^OpenAI photo description failed \(HTTP 500\)$/,
  )
  // The outcome is uncertain, so the receipt stays dispatched and nothing is retried blindly.
  expect(h.rateLimited).not.toHaveBeenCalled()
})

it('rejects incomplete, refused and empty responses', async () => {
  const respond = (body: unknown) =>
    mocks.fetch
      .mockResolvedValueOnce(new Response(new Uint8Array(jpeg)))
      .mockResolvedValueOnce(Response.json(body))
  const run = () => {
    storageByteCache.clear()
    return describePhotoOpenAI('display/test.jpg', 'gpt-6.2-sol', 'p')
  }
  respond({
    ...completed(),
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
  })
  await expect(run()).rejects.toThrow('incomplete')
  respond({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
  })
  await expect(run()).rejects.toThrow('declined')
  respond({ status: 'completed', output: [] })
  await expect(run()).rejects.toThrow('no photo description')
  respond({ error: { message: 'private' } })
  await expect(run()).rejects.toThrow('incomplete')
})

it('accepts only display images', async () => {
  await expect(describePhotoOpenAI('originals/test.jpg', 'gpt-6.2-sol', 'p')).rejects.toThrow(
    'display image',
  )
  expect(request()).toBeUndefined()
})
