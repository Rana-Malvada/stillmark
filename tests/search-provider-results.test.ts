import { expect, it } from 'vitest'
import { searchProviderMatches } from '@/lib/search/search-provider-results'

it.each([null, undefined, {}, [], { results: null }, { results: {} }, { results: 'empty' }])(
  'reports malformed provider envelopes as unavailable, not zero matches: %j',
  (payload) => {
    expect(() => searchProviderMatches(payload, 'PHOTO_ID')).toThrow(
      expect.objectContaining({ status: 503 }),
    )
  },
)
it('accepts an explicitly empty result set', () => {
  expect(searchProviderMatches({ results: [] }, 'PHOTO_ID').size).toBe(0)
})
it('preserves first-seen ranking and finite zero/negative scores while discarding invalid entries', () => {
  const result = searchProviderMatches(
    {
      results: [
        null,
        [],
        true,
        'bad',
        { PHOTO_ID: true },
        { PHOTO_ID: {} },
        { PHOTO_ID: 0 },
        { PHOTO_ID: -1 },
        { PHOTO_ID: 1.5 },
        {
          PHOTO_ID: 9,
          '@scores': { reranker_score: -4, text_match: 0, cosine_similarity: Infinity, other: 50 },
        },
        { PHOTO_ID: '3', '@scores': null },
        { PHOTO_ID: 9, '@scores': { reranker_score: 99 } },
      ],
    },
    'PHOTO_ID',
  )
  expect([...result]).toEqual([
    [9, { reranker_score: -4, text_match: 0 }],
    [3, {}],
  ])
})
it('uses the requested primary key without inferring another result type', () => {
  expect([
    ...searchProviderMatches({ results: [{ PHOTO_ID: 5 }, { EVENT_ID: '8' }] }, 'EVENT_ID'),
  ]).toEqual([[8, {}]])
})
