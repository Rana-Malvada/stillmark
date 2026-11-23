import { expect, it } from 'vitest'
import { applySearchQuality } from '../lib/search/search-quality'
import { guardedBatchOrder, rankingDocuments } from '../lib/search/search-evidence'

const rows = Array.from({ length: 5 }, (_, i) => ({
  photoId: i + 1,
  scores: { reranker_score: -10.5 - i / 10, text_match: 0 },
}))
it('abstains only for uniformly weak semantic evidence and permits explicit related results', () => {
  const result = { source: 'semantic', count: 5, results: rows }
  expect(applySearchQuality(result)).toMatchObject({
    count: 0,
    results: [],
    relatedAvailable: true,
  })
  expect(applySearchQuality(result, true).results).toEqual(rows)
  expect(applySearchQuality(result, true).notice).toContain('loosely related')
})
it('preserves structured matches and requires support for unscored semantic hits', () => {
  const exact = { source: 'people', count: 5, results: rows }
  expect(applySearchQuality(exact)).toBe(exact)
  expect(
    applySearchQuality({
      source: 'semantic',
      count: 1,
      results: [{ scores: { text_match: 0.00001 } }],
    }),
  ).toMatchObject({ results: [], relatedAvailable: true })
})
it('keeps a well-separated relevance group ahead of a weaker batch-model suggestion', () => {
  const rows = [-0.6, -0.8, -0.9, -1.7, -2.83, -3.22].map((score, i) => ({
    photoId: i + 1,
    scores: { reranker_score: score },
    aiDescription: 'Evidence',
  }))
  const docs = rankingDocuments(rows, 'an arbitrary subject')
  expect(docs.map((d) => d.retrievalTier)).toEqual([1, 1, 1, 1, 0, 0])
  expect(
    guardedBatchOrder([1, 2, 3, 4, 5, 6], [5, 6, 1, 2, 3, 4], docs).slice(0, 4).sort(),
  ).toEqual([1, 2, 3, 4])
  expect(new Set(guardedBatchOrder([1, 2, 3, 4, 5, 6], [999, 6], docs))).toEqual(
    new Set([1, 2, 3, 4, 5, 6]),
  )
})
it('does not invent a protected group for continuous or missing scores', () => {
  expect(rankingDocuments(rows, 'scene').every((d) => d.retrievalTier === 0)).toBe(true)
  expect(
    rankingDocuments([{ photoId: 1 }, { photoId: 2 }], 'scene').every((d) => d.retrievalTier === 0),
  ).toBe(true)
})

it('evaluates each candidate separately, including a single weak hit', () => {
  for (const evidence of [
    { keywordMatch: true },
    { keywordScore: 0.1 },
    { subjectMatch: true },
    { scores: { reranker_score: 1 } },
  ]) {
    const first = { ...rows[0], ...evidence }
    expect(
      applySearchQuality({ source: 'semantic', count: 2, results: [first, rows[1]] }),
    ).toMatchObject({ count: 1, results: [first], relatedAvailable: true })
  }
  expect(applySearchQuality({ source: 'semantic', count: 1, results: [rows[0]] }).count).toBe(0)
})
