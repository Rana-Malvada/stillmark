import { expect, it } from 'vitest'
import {
  allowsVisualSearch,
  evidenceTier,
  guardedBatchOrder,
  identifierRequirements,
  protectEvidence,
  rankingDocument,
} from '../lib/search/search-evidence'

it.each([
  'motocross racers with number 6',
  'show me all the motocross racers with the nubmer 6',
  'rider #6',
  'racing bikes numbered 6',
])('recognizes explicit identifiers without an LLM: %s', (query) => {
  expect(identifierRequirements(query)).toEqual([{ kind: 'race', value: '6' }])
})
it.each([
  'license plate number 9XAC643',
  'cars with registration plate 9xac643',
  'license plates reading 9XAC643',
])('recognizes plate identifiers: %s', (query) => {
  expect(identifierRequirements(query)).toEqual([{ kind: 'plate', value: '9XAC643' }])
})
it.each([
  '6 people at a restaurant',
  'photos in 2026',
  'race number 6 or 57',
  'racing without number 6',
])('does not invent precise requirements: %s', (query) => {
  expect(identifierRequirements(query)).toEqual([])
})
it('keeps multiple-rider evidence and separates unknown from conflicting numbers', () => {
  const query = 'motocross number 6'
  const rows = [
    { photoId: 57, aiDescription: 'A motocross rider numbered 57.' },
    { photoId: 2, aiDescription: 'A motocross rider jumps.' },
    { photoId: 6, aiDescription: 'Riders number 57 and number 6 race.' },
  ]
  expect(protectEvidence(query, rows).map((r) => r.photoId)).toEqual([6, 2, 57])
  expect(
    evidenceTier(identifierRequirements(query), {
      eventName: 'Motocross number 6',
      aiDescription: 'A rider numbered 57.',
    }),
  ).toBe(0)
  expect(
    evidenceTier(identifierRequirements(query), {
      aiDescription: 'A restaurant table for number 6.',
    }),
  ).toBe(1)
})
it('does not accept a substring or album label as an exact plate match', () => {
  const req = identifierRequirements('license plate 9XAC643')
  expect(evidenceTier(req, { aiDescription: 'A car with license plate 9XAC6430.' })).toBe(0)
  expect(evidenceTier(req, { eventName: '9XAC643', aiDescription: 'A car.' })).toBe(1)
  expect(evidenceTier(req, { ocrText: 'California 9XAC643 DEC' })).toBe(2)
})
it.each([
  'Motocross riders with numbered plates visible including 3, 120, 13, 21, 6, 12, 60, and 7.',
  'Motocross riders with visible race numbers include 57, 6 and 119.',
])('preserves matches in an explicitly enumerated race-number list: %s', (aiDescription) => {
  expect(evidenceTier(identifierRequirements('motocross number 6'), { aiDescription })).toBe(2)
})
it('does not mistake the rider count or a different number for race number 6', () => {
  expect(
    evidenceTier(identifierRequirements('motocross number 6'), {
      aiDescription: '6 motocross riders. Visible numbers include 60, 57 and 119.',
    }),
  ).toBe(0)
})
it.each(['number 6 racers', 'plate 9XAC643', '"Vespertine" menu', 'without snow'])(
  'blocks visual similarity for literal/negative intent: %s',
  (query) => expect(allowsVisualSearch(query)).toBe(false),
)
it.each(['snowy mountains', 'people around a dinner table', 'eating at a restaurant'])(
  'allows scene retrieval: %s',
  (query) => expect(allowsVisualSearch(query)).toBe(true),
)
it('bounds each document field and labels album context after photo evidence', () => {
  const d = rankingDocument(
    {
      aiDescription: 'A menu.',
      ocrText: 'x'.repeat(30000),
      eventName: 'Vespertine',
      caption: 'Dinner',
      aiTags: ['menu'],
    },
    'menu',
    1,
  )
  expect(d.text.startsWith('Photo description: A menu.')).toBe(true)
  expect(d.text).toContain('Album context (not necessarily visible): Vespertine')
  expect(d.text).toContain('Caption: Dinner')
  expect(d.text.length).toBeLessThan(2100)
})
it('batch results cannot add IDs, drop candidates, or overrule exact evidence', () => {
  expect(
    guardedBatchOrder(
      [1, 2, 3],
      [999, 3, 3],
      [
        { id: 1, evidenceTier: 2 },
        { id: 2, evidenceTier: 1 },
        { id: 3, evidenceTier: 0 },
      ],
    ),
  ).toEqual([1, 2, 3])
})
it('blends reranking rather than letting an extreme reversal replace the baseline', () => {
  const baseline = Array.from({ length: 50 }, (_, i) => i + 1)
  const ranked = guardedBatchOrder(baseline, [...baseline].reverse(), [])
  expect(ranked[0]).toBe(1)
  expect(new Set(ranked)).toEqual(new Set(baseline))
})

it('protects explicit plate jurisdictions without confusing album locations', () => {
  const req = identifierRequirements('cars with California license plates and only california')
  expect(req).toEqual([{ kind: 'plate-region', value: 'California' }])
  expect(
    evidenceTier(req, { aiDescription: 'A car with a Florida license plate.', city: 'California' }),
  ).toBe(0)
  expect(evidenceTier(req, { aiDescription: 'A car with a California license plate.' })).toBe(2)
  expect(evidenceTier(req, { aiDescription: 'A car parked in California.' })).toBe(1)
})

it('distinguishes Virginia and West Virginia even when both occur in one photo', () => {
  const req = identifierRequirements('Virginia license plates')
  expect(identifierRequirements('West Virginia license plates')).toEqual([
    { kind: 'plate-region', value: 'West Virginia' },
  ])
  expect(evidenceTier(req, { aiDescription: 'A West Virginia license plate.' })).toBe(0)
  expect(
    evidenceTier(req, {
      aiDescription: 'A West Virginia license plate and a Virginia license plate.',
    }),
  ).toBe(2)
})
