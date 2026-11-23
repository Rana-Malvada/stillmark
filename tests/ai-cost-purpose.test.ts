import { expect, it } from 'vitest'
import { aiCostPurpose } from '@/lib/ai-cost-purpose'

it('follows explicit tasks regardless of model changes', () => {
  expect(aiCostPurpose({ MODEL_NAME: 'gemini-3.5-flash' }, 'photo_ai')).toBe('photo_ai')
  expect(aiCostPurpose({ MODEL_NAME: 'claude-sonnet-4-6' }, 'video_ai')).toBe('video_ai')
  expect(aiCostPurpose({ MODEL_NAME: 'claude-sonnet-4-6' })).toBe('other_ai')
  expect(aiCostPurpose({}, 'ai')).toBe('other_ai')
})
it('uses verified historical purpose for legacy mixed AI records and manual tests', () => {
  expect(aiCostPurpose({ HISTORY_KIND: 'video_ai', MODEL_NAME: 'gemini-3.5-flash' }, 'ai')).toBe(
    'video_ai',
  )
  expect(aiCostPurpose({ HISTORY_KIND: 'photo_ai' }, 'ai')).toBe('photo_ai')
  expect(aiCostPurpose({ HISTORY_KIND: 'video_ai' })).toBe('video_ai')
})
it('keeps inherited search tags out of photo/video charges', () => {
  expect(aiCostPurpose({ HISTORY_KIND: 'search_indexing' }, 'photo_ai')).toBe('search_indexing')
  expect(aiCostPurpose({ HISTORY_KIND: 'search_ai' }, 'video_ai')).toBe('search_ai')
})

it('does not infer a purpose from changed SQL, prompts or models', () => {
  const row = {
    QUERY_TEXT: 'a completely different query',
    PROMPT: 'a changed prompt',
    MODEL_NAME: 'unrecognized-model',
  }
  expect(aiCostPurpose(row, 'photo_ai')).toBe('photo_ai')
  expect(aiCostPurpose(row, 'video_ai')).toBe('video_ai')
  expect(aiCostPurpose({ ...row, VERIFIED_KIND: 'video_ai' }, 'ai')).toBe('video_ai')
  expect(
    aiCostPurpose({ ...row, QUERY_TEXT: '/* personal-photos:photo_ai */ SELECT AI_COMPLETE(...)' }),
  ).toBe('other_ai')
})
it('holds unknown refresh embeddings out of totals until metadata arrives', () => {
  expect(aiCostPurpose({ SOURCE_KIND: 'pending_embedding' }, 'photo_ai')).toBe('pending_embedding')
  expect(
    aiCostPurpose(
      { SOURCE_KIND: 'pending_embedding', VERIFIED_KIND: 'search_indexing' },
      'photo_ai',
    ),
  ).toBe('search_indexing')
  expect(aiCostPurpose({ SOURCE_KIND: 'search_indexing' }, 'video_ai')).toBe('search_indexing')
})
