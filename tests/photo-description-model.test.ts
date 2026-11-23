import { afterEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  one: vi.fn(),
  query: vi.fn(),
  describe: vi.fn(),
  openai: vi.fn(),
  lock: vi.fn(),
  Unavailable: class extends Error {
    constructor(
      message: string,
      public pause = true,
    ) {
      super(message)
    }
  },
}))
vi.mock('@/lib/postgres', () => ({
  pgQueryOne: mock.one,
  pgQuery: mock.query,
  pgIndependent: async (sql: string) =>
    sql.startsWith('SELECT * FROM photo_inference_receipts WHERE photo_id=')
      ? [{ state: 'prepared' }]
      : [],
  withAdvisoryLock: (_key: string, fn: () => unknown) => {
    mock.lock()
    return fn()
  },
}))
vi.mock('@/lib/database/database-context', () => ({
  withServiceDatabase: (fn: () => unknown) => fn(),
}))
vi.mock('@/lib/costs/cost-work', () => ({
  costWork: (_purpose: string, _owners: unknown, fn: () => unknown) => fn(),
}))
vi.mock('@/lib/snowflake/cortex-photo', () => ({ describePhoto: mock.describe }))
vi.mock('@/lib/ai/openai-photo', () => ({
  describePhotoOpenAI: mock.openai,
  PhotoAiProviderUnavailable: mock.Unavailable,
}))
vi.mock('@/lib/snowflake', () => ({ querySnowflakeLongRunning: vi.fn() }))
import {
  AI_PROMPT_VERSION,
  photoAiProvider,
  photoAiProviders,
  processAllUncategorized,
  resumeOpenAi,
} from '@/lib/ai-categorize'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
  resumeOpenAi()
})
it('uses Sonnet for new descriptions and excludes cached results from older model/prompt versions', async () => {
  mock.query.mockResolvedValue([{ photo_id: 9 }])
  vi.stubEnv('PHOTO_AI_TRANSPORT', 'rest')
  let claimed = false
  mock.one.mockImplementation(async (sql: string, binds: unknown[]) => {
    if (sql.startsWith('WITH candidate')) {
      if (claimed) return null
      claimed = true
      return {
        photo_id: 9,
        display_stage_path: 'display/9.jpg',
        file_hash: 'same-bytes',
        ai_attempts: 1,
      }
    }
    if (sql.startsWith('SELECT ai_description')) {
      expect(sql).toContain('ai_prompt_version=$2')
      expect(binds).toEqual(['same-bytes', AI_PROMPT_VERSION])
      return null
    }
    return { owner_username: 'OWNER' }
  })
  mock.describe.mockResolvedValue('{"description":"The Eiffel Tower.","tags":["eiffel tower"]}')
  expect(await processAllUncategorized()).toEqual({ processed: 1, errors: [] })
  expect(mock.describe).toHaveBeenCalledWith(
    'display/9.jpg',
    'claude-sonnet-4-6',
    expect.stringContaining('Identify recognizable landmarks'),
    expect.objectContaining({ dispatched: expect.any(Function), received: expect.any(Function) }),
  )
  expect(mock.query).toHaveBeenCalledWith(expect.stringContaining('ai_prompt_version=$5'), [
    9,
    'The Eiffel Tower.',
    ['eiffel tower'],
    expect.any(String),
    AI_PROMPT_VERSION,
  ])
})

it('uses short fair claims behind the rolling-upgrade lock and does not count a stale publication', async () => {
  vi.stubEnv('PHOTO_AI_LEASED_ADMISSION', 'true')
  vi.stubEnv('PHOTO_AI_TRANSPORT', 'rest')
  vi.stubEnv('PHOTO_AI_MAX_CLAIMS_PER_HOUR', '100')
  vi.stubEnv('PHOTO_AI_TENANT_MAX_CLAIMS_PER_HOUR', '50')
  let claimed = false
  mock.one.mockImplementation(async (sql: string, binds: unknown[]) => {
    if (sql.includes('claim_photo_ai')) {
      expect(binds.slice(1)).toEqual([3, 1, 100, 50])
      if (claimed) return null
      claimed = true
      return {
        photo_id: 9,
        display_stage_path: 'display/9.jpg',
        file_hash: 'same-bytes',
        ai_attempts: 1,
      }
    }
    return {
      ai_description: 'cached current model',
      ai_tags: [],
      ai_prompt_version: AI_PROMPT_VERSION,
    }
  })
  mock.query.mockResolvedValue([])
  expect(await processAllUncategorized()).toEqual({ processed: 0, errors: [] })
  expect(mock.lock).toHaveBeenCalledOnce()
  expect(mock.describe).not.toHaveBeenCalled()
  expect(mock.query).toHaveBeenCalledWith(
    expect.stringContaining('AND ai_claim=$4 RETURNING photo_id'),
    expect.any(Array),
  )
})

/** Hand out the given photos one at a time; no identical file has been described before. */
function queue(...ids: number[]) {
  const waiting = [...ids]
  mock.one.mockImplementation(async (sql: string) => {
    if (sql.startsWith('WITH candidate')) {
      const id = waiting.shift()
      return id
        ? {
            photo_id: id,
            display_stage_path: `display/${id}.jpg`,
            file_hash: `h${id}`,
            ai_attempts: 1,
          }
        : null
    }
    if (sql.startsWith('SELECT ai_description')) return null
    return { owner_username: 'OWNER' }
  })
  mock.query.mockImplementation(async (_sql: string, binds?: unknown[]) => [
    { photo_id: binds?.[0] },
  ])
}
const published = () =>
  mock.query.mock.calls
    .filter(([sql]) => String(sql).includes('ai_prompt_version=$5'))
    .map(([, binds]) => [binds[0], binds[4]])

it('describes with OpenAI when selected and records which model wrote the description', async () => {
  vi.stubEnv('PHOTO_AI_TRANSPORT', 'rest')
  vi.stubEnv('PHOTO_AI_PROVIDER', 'openai')
  vi.stubEnv('PHOTO_AI_LOCAL_WORKERS', '1')
  queue(9)
  mock.openai.mockResolvedValue('{"description":"A red bridge.","tags":["bridge"]}')
  expect(await processAllUncategorized()).toEqual({ processed: 1, errors: [] })
  expect(mock.openai).toHaveBeenCalledWith(
    'display/9.jpg',
    'gpt-6.2-astra',
    expect.stringMatching(/Name the place[\s\S]*Do not identify people by face/),
    expect.objectContaining({ dispatched: expect.any(Function) }),
  )
  expect(mock.describe).not.toHaveBeenCalled()
  expect(published()).toEqual([[9, 'v4-openai-gpt-6.2-astra']])
})

it('falls back to Cortex when OpenAI cannot take the request, and stops asking for a while', async () => {
  vi.stubEnv('PHOTO_AI_TRANSPORT', 'rest')
  vi.stubEnv('PHOTO_AI_PROVIDER', 'openai')
  queue(1, 2)
  mock.openai.mockRejectedValue(new mock.Unavailable('OpenAI credit is used up'))
  mock.describe.mockResolvedValue('{"description":"A lake.","tags":["lake"]}')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await processAllUncategorized()).toEqual({ processed: 2, errors: [] })
  expect(mock.describe).toHaveBeenCalledTimes(2)
  // Every description is labelled with the model that actually wrote it.
  expect(published().sort()).toEqual([
    [1, AI_PROMPT_VERSION],
    [2, AI_PROMPT_VERSION],
  ])
  expect(photoAiProvider().name).toBe('cortex')
  expect(photoAiProvider(Date.now() + 31 * 60_000).name).toBe('openai')
  warn.mockRestore()
})

it('uses Cortex for one photo OpenAI will not accept, without pausing OpenAI', async () => {
  vi.stubEnv('PHOTO_AI_TRANSPORT', 'rest')
  vi.stubEnv('PHOTO_AI_PROVIDER', 'openai')
  vi.stubEnv('PHOTO_AI_LOCAL_WORKERS', '1')
  queue(1, 2)
  mock.openai
    .mockRejectedValueOnce(new mock.Unavailable('OpenAI did not accept the request', false))
    .mockResolvedValueOnce('{"description":"A boat.","tags":["boat"]}')
  mock.describe.mockResolvedValue('{"description":"A lake.","tags":["lake"]}')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await processAllUncategorized()).toEqual({ processed: 2, errors: [] })
  expect(published().sort()).toEqual([
    [1, AI_PROMPT_VERSION],
    [2, 'v4-openai-gpt-6.2-astra'],
  ])
  vi.restoreAllMocks()
})

it('does not fall back after an ordinary OpenAI failure, which may have been charged', async () => {
  vi.stubEnv('PHOTO_AI_TRANSPORT', 'rest')
  vi.stubEnv('PHOTO_AI_PROVIDER', 'openai')
  queue(1)
  mock.openai.mockRejectedValue(new Error('OpenAI photo description failed (HTTP 500)'))
  const result = await processAllUncategorized()
  expect(result.processed).toBe(0)
  expect(result.errors).toEqual([{ photoId: 1, error: expect.stringContaining('HTTP 500') }])
  expect(mock.describe).not.toHaveBeenCalled()
  expect(photoAiProvider().name).toBe('openai')
})

it('keeps the place-naming rule out of the instructions Claude receives', async () => {
  vi.stubEnv('PHOTO_AI_TRANSPORT', 'rest')
  queue(1)
  mock.describe.mockResolvedValue('{"description":"A lake.","tags":["lake"]}')
  await processAllUncategorized()
  expect(mock.describe.mock.calls[0][2]).not.toContain('Name the place')
  expect(mock.describe.mock.calls[0][2]).toContain('Do not invent names')
})

it('reads the provider order from a list, with Cortex always the last resort', () => {
  const order = (value: string) => {
    vi.stubEnv('PHOTO_AI_PROVIDER', value)
    return photoAiProviders().map((p) => p.name)
  }
  expect(order('')).toEqual(['cortex'])
  expect(order('openai')).toEqual(['openai', 'cortex'])
  expect(order('openai, cortex')).toEqual(['openai', 'cortex'])
  expect(() => order('openai,openai')).toThrow('Invalid PHOTO_AI_PROVIDER')
  expect(() => order('openai,')).toThrow('Invalid PHOTO_AI_PROVIDER')
  vi.stubEnv('PHOTO_AI_PROVIDER', 'openai')
  vi.stubEnv('PHOTO_AI_OPENAI_MODEL', 'gpt-6.2-sol')
  expect(photoAiProviders()[0]).toMatchObject({
    model: 'gpt-6.2-sol',
    version: 'v4-openai-gpt-6.2-sol',
  })
})

it('rejects an unknown provider or an unpriced model before claiming any photo', async () => {
  vi.stubEnv('PHOTO_AI_TRANSPORT', 'rest')
  vi.stubEnv('PHOTO_AI_PROVIDER', 'someone-else')
  await expect(processAllUncategorized()).rejects.toThrow('Invalid PHOTO_AI_PROVIDER')
  vi.stubEnv('PHOTO_AI_PROVIDER', 'openai')
  vi.stubEnv('PHOTO_AI_OPENAI_MODEL', 'gpt-unpriced')
  await expect(processAllUncategorized()).rejects.toThrow('Invalid PHOTO_AI_OPENAI_MODEL')
  expect(mock.one).not.toHaveBeenCalled()
})
