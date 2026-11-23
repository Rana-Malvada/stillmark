import { expect, it, vi } from 'vitest'

vi.mock('@/lib/snowflake', () => ({ querySnowflakeLongRunning: vi.fn() }))
vi.mock('@/lib/snowflake/cortex-photo', () => ({ describePhoto: vi.fn() }))
import { parseDescription } from '@/lib/ai-categorize'

it('accepts the Agents response with whitespace before fenced JSON', () => {
  expect(
    parseDescription('\n\n```json\n{"description":"A potted plant.","tags":["plant"]}\n```\n'),
  ).toEqual({ description: 'A potted plant.', tags: ['plant'] })
})
it('still rejects incomplete JSON', () => {
  expect(() => parseDescription('\n```json\n{"description":')).toThrow()
})
it.each([
  '{"description":"A potted plant.","tags":["plant"]}\nNote: the background is indistinct.',
  '```json\n{"description":"A potted plant.","tags":["plant"]}\n```\nDescription based on visible details.',
])('accepts complete description JSON followed by commentary', (raw) => {
  expect(parseDescription(raw)).toEqual({ description: 'A potted plant.', tags: ['plant'] })
})
it('handles escaped quotes, backslashes and braces inside strings', () => {
  const payload = { description: 'A sign reads "{garden}" beside a \\ symbol.', tags: ['sign'] }
  expect(parseDescription(JSON.stringify(payload) + '\nVisible text.')).toEqual(payload)
})
it.each([
  '{"description":"One","tags":[]} {"description":"Two","tags":[]}',
  '{"description":"One","tags":[]}\n["another result"]',
  '{"description":"One","tags":[],}',
  '{"description":"One","tags":["plant"}',
  '{"description":"Unfinished',
  'Here is JSON: {"description":"One"}',
  '{"description":"One"}, "description":"Two"',
])('rejects incomplete, invalid or ambiguous output', (raw) => {
  expect(() => parseDescription(raw)).toThrow()
})
it('preserves object and double-encoded response support', () => {
  const payload = { description: 'A garden.', tags: ['garden'] }
  expect(parseDescription(payload)).toEqual(payload)
  expect(parseDescription(JSON.stringify(JSON.stringify(payload)))).toEqual(payload)
})
it('bounds raw responses and retains description validation', () => {
  expect(() => parseDescription(' '.repeat(64001))).toThrow(/too large/)
  expect(() => parseDescription('{"description":""}\nCommentary')).toThrow(/usable/)
})
