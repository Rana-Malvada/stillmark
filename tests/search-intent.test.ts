import { expect, it, vi } from 'vitest'
import { databaseContext, withDatabaseRequest } from '@/lib/database/database-context'

vi.mock('@/lib/identity/auth', () => ({ getCallerIdentity: vi.fn() }))
vi.mock('@/lib/snowflake', () => ({ getServiceToken: vi.fn() }))
import { needsInterpretation, validateIntent } from '@/lib/search/search-intent'

const valid = {
  branches: [{ include: ['Keith'], exclude: ['Raul'] }],
  keywords: 'dinner',
  excludedKeywords: ['beach'],
  fromYear: 2020,
  throughYear: 2026,
  clarification: null,
}
it.each(['beach', 'red car', 'snowy mountain', 'Keith Lambert'])(
  'bypasses Haiku for %s',
  (query) => {
    expect(needsInterpretation(query, query, false)).toBe(false)
  },
)
it.each([
  'Show me photos where Keith and Raul appear in the same frame',
  'Keith without Raul',
  'either Keith or Raul',
  'photos after 2020',
  'I remember a picnic beside a river',
])('routes complex request: %s', (query) => {
  expect(needsInterpretation(query, query, true)).toBe(true)
})
it('accepts a bounded filter plan', () => expect(validateIntent(valid)).toEqual(valid))
it.each([
  { ...valid, branches: [] },
  { ...valid, fromYear: 2027 },
  { ...valid, branches: [{ include: ['x'.repeat(151)], exclude: [] }] },
  { ...valid, keywords: 42 },
  { ...valid, throughYear: '2026' },
])('rejects malformed or excessive plans', (plan) => expect(() => validateIntent(plan)).toThrow())

vi.mock('@/lib/costs/cost-work', () => ({
  costWork: async (_category: string, _owners: unknown, fn: () => unknown) => {
    expect(databaseContext.getStore()?.kind).toBe('service')
    return fn()
  },
}))
vi.mock('@/lib/snowflake/cortex-rest-costs', () => ({
  beginRestCost: async () => 'test-id',
  finishRestCost: vi.fn(),
}))
vi.mock('@/lib/postgres', () => ({ pgIndependent: vi.fn() }))
it('propagates the overall search signal into interpretation and uses the verified operation identity', async () => {
  const { getCallerIdentity } = await import('@/lib/identity/auth')
  const { getServiceToken } = await import('@/lib/snowflake')
  const { interpretSearch } = await import('@/lib/search/search-intent')
  vi.mocked(getCallerIdentity).mockClear()
  vi.mocked(getServiceToken).mockReturnValue('test-token')
  const controller = new AbortController()
  const fetch = vi.fn(
    (_url, init) =>
      new Promise<Response>((_, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }),
      ),
  )
  vi.stubGlobal('fetch', fetch)
  try {
    const pending = databaseContext.run(
      {
        kind: 'request',
        signal: controller.signal,
        identity: Promise.resolve({
          username: 'ALICE',
          mainAdmin: false,
          adminRead: false,
          adminWrite: false,
          canWrite: true,
          accessManager: false,
        }),
      },
      () => interpretSearch('Keith without Raul', []),
    )
    const failed = expect(pending).rejects.toThrow('total search deadline')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    controller.abort(Error('total search deadline'))
    await failed
    expect(getCallerIdentity).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('cancels an unsuccessful interpretation response body before surfacing failure', async () => {
  const { getCallerIdentity } = await import('@/lib/identity/auth')
  const { getServiceToken } = await import('@/lib/snowflake')
  const { interpretSearch } = await import('@/lib/search/search-intent')
  vi.mocked(getCallerIdentity).mockResolvedValue({ username: 'ALICE' } as any)
  vi.mocked(getServiceToken).mockReturnValue('test-token')
  const cancel = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 503 })),
  )
  try {
    await expect(interpretSearch('Keith without Raul', [])).rejects.toMatchObject({ status: 503 })
    expect(cancel).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
  }
})
it('records reported usage, requests only Haiku, and validates the response', async () => {
  const { getCallerIdentity } = await import('@/lib/identity/auth')
  const { getServiceToken } = await import('@/lib/snowflake')
  vi.mocked(getCallerIdentity).mockResolvedValue({ username: 'ALICE' } as any)
  vi.mocked(getServiceToken).mockReturnValue('test-token')
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(valid) }],
      usage: { input_tokens: 123, output_tokens: 45 },
    }),
  )
  vi.stubGlobal('fetch', fetch)
  try {
    const { interpretSearch } = await import('@/lib/search/search-intent')
    const result = await withDatabaseRequest(async () => {
      const result = await interpretSearch('Keith without Raul', [])
      expect(databaseContext.getStore()?.kind).toBe('request')
      return result
    })()
    expect(result.intent).toEqual(valid)
    expect(result.metrics).toMatchObject({ inputTokens: 123, outputTokens: 45 })
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.model).toBe('claude-sonnet-4-6')
    expect(body.max_tokens).toBe(2048)
    expect(body.temperature).toBe(0)
    expect(body.output_config.format.type).toBe('json_schema')
    expect(body.output_config.format.schema.additionalProperties).toBe(false)
    expect(body.output_config.format.schema.required).toEqual([
      'nodes',
      'root',
      'keywords',
      'clarification',
    ])
    expect(fetch.mock.calls[0][0]).toContain('/cortex/v1/messages')
    expect(body.tools).toBeUndefined()
    expect(body.messages[0].content.map((c: { type: string }) => c.type)).toEqual(['text'])
    fetch.mockResolvedValueOnce(
      Response.json({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'not valid JSON' }],
      }),
    )
    await expect(interpretSearch('Try a complex request', [])).rejects.toMatchObject({
      status: 502,
    })
  } finally {
    vi.unstubAllGlobals()
  }
})

it('records truncated direct responses and refuses partial filter plans', async () => {
  const { getCallerIdentity } = await import('@/lib/identity/auth')
  const { getServiceToken } = await import('@/lib/snowflake')
  const { finishRestCost } = await import('@/lib/snowflake/cortex-rest-costs')
  const { interpretSearch } = await import('@/lib/search/search-intent')
  vi.mocked(getCallerIdentity).mockResolvedValue({ username: 'ALICE' } as any)
  vi.mocked(getServiceToken).mockReturnValue('test-token')
  const usage = { input_tokens: 600, output_tokens: 2048 }
  const fetch = vi.fn().mockResolvedValue(
    Response.json(
      {
        stop_reason: 'max_tokens',
        usage,
        content: [{ type: 'text', text: JSON.stringify(valid) }],
      },
      { headers: { 'request-id': 'direct-truncated' } },
    ),
  )
  vi.stubGlobal('fetch', fetch)
  try {
    await expect(interpretSearch('Keith or Raul', [])).rejects.toMatchObject({ status: 502 })
    expect(finishRestCost).toHaveBeenCalledWith(
      'test-id',
      'claude-sonnet-4-6',
      usage,
      'direct-truncated',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
  }
})
it('counts direct cache tokens without double counting uncached input', async () => {
  const { interpretSearch } = await import('@/lib/search/search-intent')
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 30,
        output_tokens: 20,
      },
      content: [{ type: 'text', text: JSON.stringify(valid) }],
    }),
  )
  vi.stubGlobal('fetch', fetch)
  try {
    expect((await interpretSearch('Keith or Raul', [])).metrics).toMatchObject({
      inputTokens: 240,
      outputTokens: 20,
    })
  } finally {
    vi.unstubAllGlobals()
  }
})
