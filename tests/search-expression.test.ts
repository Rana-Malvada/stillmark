import { afterAll, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  albumDomainExpression,
  compileExpression,
  validExpression,
} from '@/lib/search/search-expression'
import { metadataClause, metadataFields } from '@/lib/search/search-metadata'
import { validateIntent } from '@/lib/search/search-intent'

const db = new PGlite()
afterAll(() => db.close())
it('bounds complexity, rejects invented fields and refuses mixed plan formats', () => {
  for (const value of [
    null,
    {},
    { all: [] },
    { any: [], not: { person: 'Alice' } },
    { field: 'secret', op: 'contains', value: 'x' },
    { near: { latitude: 91, longitude: 0, km: 2 } },
    { field: 'iso', op: 'gte', value: '0);DROP TABLE photos' },
    { all: Array.from({ length: 21 }, () => ({ person: 'A' })) },
  ])
    expect(validExpression(value)).toBe(false)
  expect(validExpression({ field: 'iso', op: 'gte', value: 800 })).toBe(true)
  expect(validExpression({ field: 'favorite', op: 'equals', value: false })).toBe(true)
  expect(validExpression({ field: 'camera_make', op: 'equals', value: 800 })).toBe(false)
  let nested: unknown = { person: 'A' }
  for (let i = 0; i < 9; i++) nested = { not: nested }
  expect(validExpression(nested)).toBe(false)
  expect(() =>
    validateIntent({
      where: { person: 'A' },
      keywords: '',
      clarification: null,
      excludedPlaces: ['Rome'],
    }),
  ).toThrow()
  expect(
    albumDomainExpression({ not: { field: 'album_event_name', op: 'contains', value: 'A' } }),
  ).toBe(true)
  expect(
    albumDomainExpression({
      any: [{ field: 'album_event_name', op: 'contains', value: 'A' }, { person: 'A' }],
    }),
  ).toBe(false)
})

// Independent values exercise every registered scalar field through PostgreSQL's
// operators. Subqueries are covered against the real catalog in people-search.
for (const [field, spec] of metadataFields) {
  if (!/^[pe]\.\w+$/.test(spec.column)) continue
  it(`matches, rejects and distinguishes missing ${field}`, async () => {
    const [alias, column] = spec.column.split('.')
    const value =
      spec.kind === 'number'
        ? '42'
        : spec.kind === 'boolean'
          ? 'true'
          : spec.kind === 'date'
            ? '2024-06-15'
            : 'A_% value'
    const type =
      spec.kind === 'number'
        ? 'numeric'
        : spec.kind === 'boolean'
          ? 'boolean'
          : spec.kind === 'date'
            ? 'timestamptz'
            : spec.kind === 'tags'
              ? 'text[]'
              : 'text'
    const stored = spec.kind === 'tags' ? [value] : value
    async function check(op: string, filter: string, input: unknown) {
      const params: unknown[] = [input]
      const sql = metadataClause({ field, op, value: filter }, (v, t) => `$${params.push(v)}::${t}`)
      return (
        await db.query<{ matches: boolean }>(
          `SELECT (${sql}) AS matches FROM (SELECT $1::${type} AS ${column}) ${alias}`,
          params,
        )
      ).rows[0].matches
    }
    expect(await check('equals', value, stored)).toBe(true)
    expect(
      await check(
        'equals',
        spec.kind === 'boolean'
          ? 'false'
          : spec.kind === 'date'
            ? '2024-06-16'
            : spec.kind === 'number'
              ? '43'
              : 'different',
        stored,
      ),
    ).toBe(false)
    expect(await check('missing', '', null)).toBe(true)
    expect(await check('exists', '', stored)).toBe(true)
    if (spec.kind === 'text') {
      expect(await check('contains', '_%', stored)).toBe(true)
      expect(await check('contains', '___', stored)).toBe(false)
      expect(await check('matches', 'mountain', 'mountains')).toBe(true)
      expect(await check('matches', 'mountain', 'desert')).toBe(false)
      expect(await check('missing', '', '   ')).toBe(true)
    }
    if (spec.kind === 'tags') expect(await check('contains', 'value', stored)).toBe(false)
  })
}
it('compares formatted EXIF numbers and leaves malformed or zero-denominator values unknown', async () => {
  for (const [field, raw, expected] of [
    ['aperture', 'f/2.8', '2.8'],
    ['aperture', '28/10', '2.8'],
    ['focal_length', '50 mm', '50'],
    ['focal_length_35mm', '75', '75'],
    ['shutter_speed', '1/250 sec', '0.004'],
    ['exposure_compensation', '-1', '-1'],
    ['digital_zoom_ratio', '2/1', '2'],
  ]) {
    const params: unknown[] = [raw]
    const clause = metadataClause(
      { field, op: 'equals', value: expected },
      (v, t) => `$${params.push(v)}::${t}`,
    )
    expect(
      (
        await db.query<{ matches: boolean }>(
          `SELECT (${clause}) AS matches FROM (SELECT $1::text AS ${field}) p`,
          params,
        )
      ).rows[0].matches,
      field,
    ).toBe(true)
  }
  for (const raw of ['unknown', '1/0', '']) {
    const clause = metadataClause({ field: 'shutter_speed', op: 'missing', value: '' }, () => {
      throw Error('unused')
    })
    expect(
      (
        await db.query<{ matches: boolean }>(
          `SELECT (${clause}) AS matches FROM (SELECT $1::text AS shutter_speed) p`,
          [raw],
        )
      ).rows[0].matches,
    ).toBe(true)
  }
})
it('keeps OR branches intact and treats negative unknown values explicitly', async () => {
  const params: unknown[] = []
  const sql = await compileExpression(
    {
      any: [
        {
          all: [
            { field: 'camera_make', op: 'equals', value: 'Canon' },
            { field: 'iso', op: 'gte', value: '800' },
          ],
        },
        {
          all: [
            { field: 'camera_make', op: 'equals', value: 'Nikon' },
            { not: { field: 'iso', op: 'gte', value: '400' } },
          ],
        },
      ],
    },
    (v, t) => `$${params.push(v)}::${t}`,
    async () => {
      throw Error('unused')
    },
  )
  const result = await db.query<{ id: number }>(
    `SELECT id FROM (VALUES (1,'Canon',800),(2,'Canon',200),(3,'Nikon',200),(4,'Nikon',800),(5,'Nikon',NULL)) p(id,camera_make,iso) WHERE ${sql} ORDER BY id`,
    params,
  )
  expect(result.rows.map((r) => r.id)).toEqual([1, 3])
})

it('decodes constrained node plans and rejects cycles, unused conditions and invalid references', async () => {
  const { expressionFromNodes, searchPlanSchema } = await import('@/lib/search/search-plan-schema')
  expect(expressionFromNodes([{ person: 'A' }, { place: 'B' }, { all: [0, 1] }], 2)).toEqual({
    all: [{ person: 'A' }, { place: 'B' }],
  })
  expect(expressionFromNodes([], null)).toBeNull()
  for (const [nodes, root] of [
    [[{ not: 0 }], 0],
    [[{ not: 2 }], 0],
    [[{ person: 'A' }, { person: 'B' }], 0],
    [[{ all: [] }], 0],
    [[{ not: 1.2 }, { person: 'B' }], 0],
    [[{ person: 'A' }], null],
  ] as const)
    expect(() => expressionFromNodes(nodes, root)).toThrow()
  expect(JSON.stringify(searchPlanSchema('photo'))).not.toContain('"photo":')
  expect(JSON.stringify(searchPlanSchema('event'))).toContain('"photo":')
  expect(
    validateIntent({
      nodes: [{ field: 'iso', op: 'gte', value: 800 }],
      root: 0,
      keywords: '',
      clarification: null,
    }).where,
  ).toEqual({ field: 'iso', op: 'gte', value: 800 })
})
