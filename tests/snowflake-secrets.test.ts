import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mounted = vi.hoisted(() => ({ files: new Map<string, string>() }))
vi.mock('fs', () => ({
  default: {
    readFileSync: (path: string) => {
      if (!mounted.files.has(path)) throw new Error('not mounted')
      return mounted.files.get(path)
    },
  },
}))
beforeEach(() => {
  vi.resetModules()
  mounted.files.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function secrets() {
  return import('@/lib/snowflake/secrets')
}
function local() {
  vi.stubEnv('SNOWFLAKE_SECRET_TEST_OAUTH_TOKEN_URL', 'https://tokens.example.test/oauth')
  vi.stubEnv('SNOWFLAKE_SECRET_TEST_OAUTH_CLIENT_ID', 'test-client')
  vi.stubEnv('SNOWFLAKE_SECRET_TEST_OAUTH_CLIENT_SECRET', 'test-credential')
}
it('reads rotated mounted secrets fresh and prioritizes them over local credentials', async () => {
  local()
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const { getSecret, SecretType } = await secrets()
  mounted.files.set('/secrets/TEST/access_token', 'first')
  expect(await getSecret('TEST', SecretType.OAUTH2)).toBe('first')
  mounted.files.set('/secrets/TEST/access_token', 'rotated')
  expect(await getSecret('TEST', SecretType.OAUTH2)).toBe('rotated')
  expect(fetcher).not.toHaveBeenCalled()
})
it('deduplicates concurrent refreshes, caches valid tokens, and sets a request deadline', async () => {
  local()
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) =>
    Response.json({ access_token: 'valid', expires_in: 300 }),
  )
  vi.stubGlobal('fetch', fetcher)
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  const { getSecret, SecretType } = await secrets()
  expect(
    await Promise.all(Array.from({ length: 20 }, () => getSecret('TEST', SecretType.OAUTH2))),
  ).toEqual(Array(20).fill('valid'))
  expect(await getSecret('TEST', SecretType.OAUTH2)).toBe('valid')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(timeout).toHaveBeenCalledWith(15_000)
  expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
})
it('clears failed inflight refreshes and never exposes a provider response body', async () => {
  local()
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('test-credential echoed by provider', { status: 401 }))
    .mockResolvedValueOnce(Response.json({ access_token: 'recovered' }))
  vi.stubGlobal('fetch', fetcher)
  const { getSecret, SecretType } = await secrets()
  await expect(getSecret('TEST', SecretType.OAUTH2)).rejects.toThrow('returned HTTP 401.')
  expect(await getSecret('TEST', SecretType.OAUTH2)).toBe('recovered')
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('recovers after a timed-out request without leaking transport error details', async () => {
  local()
  const controller = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  const fetcher = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('test-credential in URL')), {
          once: true,
        })
      }),
  )
  vi.stubGlobal('fetch', fetcher)
  const { getSecret, SecretType } = await secrets()
  const failed = expect(getSecret('TEST', SecretType.OAUTH2)).rejects.toThrow(
    'token request failed or timed out.',
  )
  controller.abort()
  await failed
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ access_token: 'retry' })),
  )
  expect(await getSecret('TEST', SecretType.OAUTH2)).toBe('retry')
})
it.each([
  null,
  {},
  { access_token: 123 },
  { access_token: ' ' },
  { access_token: 'x', expires_in: -1 },
  { access_token: 'x', expires_in: '300' },
])('rejects malformed token responses without caching them: %j', async (body) => {
  local()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body)),
  )
  const { getSecret, SecretType } = await secrets()
  await expect(getSecret('TEST', SecretType.OAUTH2)).rejects.toThrow('invalid token response')
})
