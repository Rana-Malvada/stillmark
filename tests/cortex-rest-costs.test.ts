import { beforeEach, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())
vi.mock('@/lib/postgres', () => ({ pgIndependent: query }))
import {
  beginRestCost,
  finishAgentCost,
  finishRestCost,
  openAiUsd,
  REST_PRICING_VERSION,
  restCredits,
} from '@/lib/snowflake/cortex-rest-costs'
import { costContext } from '@/lib/costs/cost-context'

beforeEach(() => vi.resetAllMocks())
it('prices input/output independently and never substitutes rates for unknown usage', () => {
  expect(restCredits('claude-haiku-4-5', { input_tokens: 1000, output_tokens: 100 })).toBe(0.00075)
  expect(restCredits('claude-haiku-4-5', { input_tokens: 0, output_tokens: 0 })).toBe(0)
  for (const usage of [
    undefined,
    {},
    { input_tokens: 100 },
    { input_tokens: -1, output_tokens: 5 },
    { input_tokens: '10', output_tokens: 5 },
    { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 20 },
  ])
    expect(restCredits('claude-haiku-4-5', usage)).toBeNull()
  expect(restCredits('future-model', { input_tokens: 100, output_tokens: 10 })).toBeNull()
})
it('records each attempt before inference, tied to immutable work ownership', async () => {
  await expect(beginRestCost('claude-haiku-4-5')).rejects.toThrow('attribution')
  const [a, b] = await costContext.run('work-id', async () => [
    await beginRestCost('claude-haiku-4-5'),
    await beginRestCost('claude-haiku-4-5'),
  ])
  expect(a).not.toBe(b)
  expect(query.mock.calls[0][1]).toEqual([a, 'work-id', 'claude-haiku-4-5', REST_PRICING_VERSION])
})
it('records only numeric token usage and leaves missing charges unavailable', async () => {
  await finishRestCost(
    'attempt',
    'claude-haiku-4-5',
    { input_tokens: 1000, output_tokens: 100, prompt: 'private' },
    'provider-id',
  )
  expect(query.mock.calls[0][1]).toEqual([
    'attempt',
    'reported',
    'provider-id',
    '{"input_tokens":1000,"output_tokens":100}',
    0.00075,
  ])
  await finishRestCost('unknown', 'claude-haiku-4-5')
  expect(query.mock.calls[1][1]).toEqual(['unknown', 'unavailable', null, null, null])
})

it('preserves Agents model usage without inventing a price or retaining response content', async () => {
  await finishAgentCost(
    'agent-attempt',
    [
      {
        model_name: 'claude-haiku-4-5',
        model_role: 'orchestration',
        input_tokens: {
          total: 10429,
          uncached: 3,
          cache_read: 7841,
          cache_write: 2585,
          prompt: 'private',
        },
        output_tokens: { total: 221 },
        content: 'private',
      },
    ],
    'agent-id',
  )
  const args = query.mock.calls[0][1]
  expect(args[1]).toBe('unavailable')
  expect(args[2]).toBe('agent-id')
  expect(args[3]).not.toContain('private')
  expect(JSON.parse(args[3]).tokens_consumed[0].input_tokens.total).toBe(10429)
  expect(query.mock.calls[0][0]).toContain('estimated_credits=NULL')
})

it('estimates Sonnet independently while preserving Haiku pricing', () => {
  const usage = { input_tokens: 2000, output_tokens: 200, cache_read_input_tokens: 100 }
  expect(restCredits('claude-sonnet-4-6', usage)).toBeCloseTo(0.004515)
  expect(restCredits('claude-haiku-4-5', usage)).toBeCloseTo(0.001505)
  expect(restCredits('claude-sonnet-4-6', { ...usage, cache_creation_input_tokens: 1 })).toBeNull()
})

it('prices OpenAI requests in dollars and never as Snowflake credits', async () => {
  // $2 per million input, $10 per million output.
  expect(openAiUsd('gpt-6.2-sol', { input_tokens: 2000, output_tokens: 300 })).toBeCloseTo(0.007)
  expect(openAiUsd('gpt-6.2-astra', { input_tokens: 3400, output_tokens: 150 })).toBeCloseTo(0.0332)
  expect(openAiUsd('gpt-6.2-sol', { input_tokens: 2000 })).toBeNull()
  expect(openAiUsd('gpt-unpriced', { input_tokens: 1, output_tokens: 1 })).toBeNull()
  expect(restCredits('gpt-6.2-sol', { input_tokens: 2000, output_tokens: 300 })).toBeNull()
  await finishRestCost(
    'attempt',
    'gpt-6.2-sol',
    { input_tokens: 2000, output_tokens: 300, output: 'private' },
    'req-1',
  )
  const [sql, binds] = query.mock.calls[0]
  expect(sql).toContain('estimated_credits=NULL')
  expect(binds.slice(0, 3)).toEqual(['attempt', 'reported', 'req-1'])
  expect(JSON.parse(binds[3])).toEqual({
    input_tokens: 2000,
    output_tokens: 300,
    estimated_usd: expect.closeTo(0.007),
  })
  await finishRestCost('unknown', 'gpt-6.2-sol')
  expect(query.mock.calls[1][1]).toEqual(['unknown', 'unavailable', null, null])
})
