import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ query: vi.fn(), one: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgQuery: m.query, pgQueryOne: m.one }))
import {
  attributedCredits,
  costScope,
  type CostSection,
  type CostWorkRow,
  knownRestCosts,
  membershipShare,
  personalCosts,
  share,
  sumCredits,
} from '@/lib/costs/personal-costs'

const viewer = { username: 'ALICE', role: 'viewer' as const, mainAdmin: false }
const owner = { ...viewer, role: 'admin' as const, appOwner: true, mainAdmin: true }
const s = (key: string, credits: number): CostSection => ({
  key,
  label: key,
  error: null,
  rows: [{ DAY: '2026-09-18', CREDITS: credits, COMPUTE_CREDITS: credits }],
})
beforeEach(() => {
  vi.resetAllMocks()
})
it('guards All and other users on the server, not just in the selector', () => {
  expect(costScope(viewer, null).selected).toBe('ALICE')
  for (const target of ['all', 'BOB', "' OR 1=1"])
    expect(() => costScope(viewer, target)).toThrow('Your own costs only')
  expect(costScope(owner, 'BOB').canFilter).toBe(true)
  expect(costScope({ ...viewer, role: 'admin_readonly' }, 'all')).toMatchObject({
    canFilter: false,
  })
  expect(() => costScope({ ...viewer, role: 'admin_readonly' }, 'BOB')).toThrow()
})
it('allocates exactly one total across owners and retains historical ownership', () => {
  const section = { ...s('personal_ai', 10), rows: [{ WORK_ID: '1', CREDITS: 10 }] }
  const work = [{ id: '1', category: 'ai', owners: { ALICE: 1, BOB: 3 } }]
  expect(attributedCredits(section, work, 'ALICE')).toBe(2.5)
  expect(attributedCredits(section, work, 'BOB')).toBe(7.5)
  expect(attributedCredits(section, work, 'MALLORY')).toBe(0)
  expect(share({}, 'ALICE')).toBe(0)
})
it('does not turn unavailable or invalid metering into zero', () => {
  expect(sumCredits(undefined)).toBeNull()
  expect(sumCredits({ ...s('ai', 1), error: 'denied' })).toBeNull()
  expect(sumCredits({ ...s('ai', 1), rows: [{ CREDITS: null }] })).toBeNull()
  expect(sumCredits({ ...s('ai', 0), rows: [] })).toBe(0)
})
it('leaves shared compute unallocated, filters personal data and hides other user identities', async () => {
  m.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT name AS username'))
      return [
        { username: 'ALICE', display_name: 'Alice Example' },
        { username: 'BOB', display_name: 'Bob Example' },
      ]
    return []
  })
  m.one.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT payload'))
      return {
        payload: { asOf: '2026-09-18T00:00:00Z', sections: [s('postgres', 20), s('runtime', 8)] },
        refreshed_at: '2026-09-18T00:00:00Z',
      }
    if (sql.includes(' AS bytes')) return { bytes: '1000', files: 2 }
    return null
  })
  const report = await personalCosts(viewer, null)
  expect(report.services.find((s) => s.key === 'postgres')?.credits).toBeNull()
  expect(report.users).toEqual([])
  expect(report.userLabels).toEqual({})
  expect(report.selectedLabel).toBe('Alice Example')
  for (const day of report.daily) expect(day).toMatchObject({ postgres: null, runtime: null })
  expect(report.canRefresh).toBe(false)
  expect(report.services.find((s) => s.key === 'runtime')?.credits).toBeNull()
  const filtered = m.one.mock.calls.filter((c) => c[0].includes('($1 OR'))
  expect(filtered).toHaveLength(2)
  for (const call of filtered) expect(call[1]).toEqual([false, 'ALICE'])
})
it('rejects forbidden filters before reading costs or user rosters', async () => {
  await expect(personalCosts(viewer, 'BOB')).rejects.toMatchObject({ status: 403 })
  expect(m.query).not.toHaveBeenCalled()
  expect(m.one).not.toHaveBeenCalled()
})

it('separates video, photo and other credits without changing the total', async () => {
  const { aiSection } = await import('@/lib/costs/personal-costs')
  const source = {
    ...s('ai', 0),
    rows: [
      { HISTORY_KIND: 'photo_ai', MODEL_NAME: 'new-model', CREDITS: 2 },
      { HISTORY_KIND: 'video_ai', MODEL_NAME: 'new-model', CREDITS: 3 },
      { MODEL_NAME: 'claude-sonnet-4-6', CREDITS: 4 },
    ],
  }
  expect(sumCredits(aiSection(source, 'photo_ai'))).toBe(2)
  expect(sumCredits(aiSection(source, 'video_ai'))).toBe(3)
  expect(sumCredits(aiSection(source, 'other_ai'))).toBe(4)
  const works: CostWorkRow[] = [
    { id: 'video', category: 'video_ai', owners: { ALICE: 1, BOB: 1 } },
    { id: 'photo', category: 'photo_ai', owners: { ALICE: 1 } },
  ]
  const tagged = {
    ...source,
    rows: [
      { WORK_ID: 'video', CREDITS: 6 },
      { WORK_ID: 'photo', CREDITS: 2 },
    ],
  }
  expect(attributedCredits(aiSection(tagged, 'video_ai', works), works, 'ALICE')).toBe(3)
  expect(attributedCredits(aiSection(tagged, 'photo_ai', works), works, 'ALICE')).toBe(2)
  expect(aiSection(undefined, 'video_ai')).toBeUndefined()
})

it('counts index embeddings once and keeps daily and total amounts consistent', async () => {
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('SELECT name AS username')
      ? [{ username: 'ALICE' }]
      : sql.includes('FROM cost_work WHERE')
        ? Array.from({ length: 5 }, (_, i) => ({
            id: String(i),
            category: 'unknown',
            owners: { ALICE: 1 },
          }))
        : [],
  )
  const rows = [
    { VERIFIED_KIND: 'photo_ai', CREDITS: 2 },
    { VERIFIED_KIND: 'video_ai', CREDITS: 3 },
    { SOURCE_KIND: 'search_ai', CREDITS: 1 },
    { CREDITS: 4 },
    { SOURCE_KIND: 'search_indexing', CREDITS: 8 },
  ].map((r, i) => ({ ...r, WORK_ID: String(i), DAY: '2026-09-18' }))
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? {
          payload: {
            asOf: '2026-09-18T00:00:00Z',
            sections: [
              { ...s('personal_ai', 0), rows },
              s('search_indexing', 8),
              s('search', 2),
              s('warehouse', 0),
              s('postgres', 0),
              s('runtime', 0),
            ],
          },
        }
      : null,
  )
  const report = await personalCosts(owner, 'all')
  expect(report.services.find((s) => s.key === 'photo_rest')?.credits).toBe(2)
  expect(report.services.find((s) => s.key === 'video_ai')?.credits).toBe(3)
  expect(report.services.find((s) => s.key === 'search_indexing')?.credits).toBe(8)
  expect(report.services.find((s) => s.key === 'search_ai')?.credits).toBe(1)
  expect(report.subtotalUsd).toBe(40)
  expect(report.daily.reduce((sum, d) => sum + (d.usd ?? 0), 0)).toBe(40)
})

it('excludes inseparable historical GPU pool usage from totals', async () => {
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('SELECT name AS username') ? [{ username: 'ALICE' }] : [],
  )
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? { payload: { asOf: '2026-09-18T00:00:00Z', sections: [s('gpu', 12)] } }
      : null,
  )
  const total = await personalCosts(owner, 'all')
  expect(total.services.find((s) => s.key === 'gpu')?.credits).toBeNull()
  expect(total.subtotalUsd).toBeNull()
  expect(total.daily.reduce((sum, d) => sum + (d.usd ?? 0), 0)).toBe(0)
  const personal = await personalCosts(viewer, null)
  expect(personal.services.find((s) => s.key === 'gpu')?.credits).toBeNull()
  expect(personal.daily.every((d) => (d as Record<string, unknown>).gpu === null)).toBe(true)
})

it('excludes inseparable historical face-pool usage from totals', async () => {
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('SELECT name AS username') ? [{ username: 'ALICE' }] : [],
  )
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? {
          payload: {
            asOf: '2026-09-18T00:00:00Z',
            sections: [s('faces', 7), s('gpu', 3), s('ai', 2)],
          },
        }
      : null,
  )
  const total = await personalCosts(owner, 'all')
  expect(total.services.find((s) => s.key === 'faces')?.credits).toBeNull()
  expect(total.subtotalUsd).toBeNull()
  expect(total.daily.reduce((sum, d) => sum + (d.usd ?? 0), 0)).toBe(0)
  expect((total.daily.at(-1) as Record<string, unknown>).faces).toBeNull()
  const personal = await personalCosts(viewer, null)
  expect(personal.services.find((s) => s.key === 'faces')?.credits).toBeNull()
  expect(personal.daily.every((d) => (d as Record<string, unknown>).faces === null)).toBe(true)
})

it('keeps missing and failed face metering unavailable rather than showing a free scan', async () => {
  m.query.mockResolvedValue([])
  m.one.mockResolvedValue(null)
  expect(
    (await personalCosts(owner, 'all')).services.find((s) => s.key === 'faces')?.credits,
  ).toBeNull()
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? {
          payload: {
            sections: [{ ...s('faces', 0), label: 'Photo face recognition', error: 'Unavailable' }],
          },
        }
      : null,
  )
  const report = await personalCosts(owner, 'all')
  expect(report.services.find((s) => s.key === 'faces')?.credits).toBeNull()
  expect(report.errors).toContain('Photo face recognition')
})

it('keeps REST estimates separate and allocates each retry to its recorded owner', async () => {
  const rest = {
    key: 'photo_rest',
    label: 'REST',
    error: null,
    rows: [
      { DAY: '2026-09-18', WORK_ID: 'rest-1', CREDITS: 0.001 },
      { DAY: '2026-09-18', WORK_ID: 'rest-2', CREDITS: 0.002 },
    ],
  }
  const works: CostWorkRow[] = [
    { id: 'rest-1', category: 'photo_ai', owners: { ALICE: 1 } },
    { id: 'rest-2', category: 'photo_ai', owners: { BOB: 1 } },
  ]
  expect(sumCredits(rest)).toBe(0.003)
  expect(attributedCredits(rest, works, 'ALICE')).toBe(0.001)
  expect(attributedCredits(rest, works, 'BOB')).toBe(0.002)
  const pending = {
    ...rest,
    rows: [...rest.rows, { DAY: '2026-09-18', WORK_ID: 'rest-2', CREDITS: null }],
  }
  expect(sumCredits(pending)).toBeNull()
  expect(attributedCredits(pending, works, 'ALICE')).toBe(0.001)
  expect(attributedCredits(pending, works, 'BOB')).toBeNull()
})

it('adds OpenAI descriptions in dollars to the owner, the subtotal and the daily chart', async () => {
  const works = [
    { id: 'a', category: 'photo_ai', owners: { ALICE: 1 } },
    { id: 'b', category: 'photo_ai', owners: { BOB: 1 } },
  ]
  m.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT name AS username'))
      return [
        { username: 'ALICE', display_name: 'Alice Example' },
        { username: 'BOB', display_name: 'Bob Example' },
      ]
    if (sql.includes('SELECT id,category,owners')) return works
    return []
  })
  const sections = (openAi: Record<string, unknown>[]) => ({
    payload: {
      asOf: '2026-09-18T00:00:00Z',
      sections: [
        { ...s('photo_rest', 0), rows: [{ DAY: '2026-09-18', WORK_ID: 'a', CREDITS: 2 }] },
        { ...s('photo_openai', 0), rows: openAi },
      ],
    },
  })
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? sections([
          { DAY: '2026-09-18', WORK_ID: 'a', USD: 0.25 },
          { DAY: '2026-09-18', WORK_ID: 'b', USD: 0.5 },
          // Rejected before any work: no amount, and not a missing Snowflake charge.
          { DAY: '2026-09-18', WORK_ID: 'b', USD: null },
        ])
      : null,
  )
  const all = await personalCosts(owner, 'all')
  expect(all.services.find((s) => s.key === 'photo_openai')).toMatchObject({
    credits: null,
    usd: 0.75,
  })
  expect(all.services.find((s) => s.key === 'photo_rest')?.credits).toBe(2)
  expect(all.subtotalUsd).toBe(4.75)
  expect(all.daily.at(-1)).toMatchObject({ photo_rest: 4, photo_openai: 0.75, usd: 4.75 })
  expect(all.restUsageMissing).toBe(false)
  const alice = await personalCosts(owner, 'ALICE')
  expect(alice.services.find((s) => s.key === 'photo_openai')?.usd).toBe(0.25)
  // No OpenAI use in the period: the line does not appear at all.
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload') ? sections([]) : null,
  )
  const none = await personalCosts(owner, 'all')
  expect(none.services.some((s) => s.key === 'photo_openai')).toBe(false)
  expect(none.daily.at(-1)).not.toHaveProperty('photo_openai')
})

it('keeps billed REST charges when another request is pending, without inventing zero charges', () => {
  const source = {
    ...s('photo_rest', 1),
    rows: [{ CREDITS: 2 }, { CREDITS: null }, { CREDITS: 3 }],
  }
  expect(sumCredits(knownRestCosts(source))).toBe(5)
  expect(sumCredits(knownRestCosts({ ...source, rows: [{ CREDITS: null }] }))).toBeNull()
  expect(sumCredits(knownRestCosts({ ...source, rows: [] }))).toBe(0)
  expect(sumCredits(knownRestCosts({ ...source, error: 'unavailable' }))).toBeNull()
})

it('separates search interpretation from photo REST in totals and daily per-user allocation', async () => {
  const works = [
    { id: 'photo', category: 'photo_ai', owners: { ALICE: 1 } },
    { id: 'search-a', category: 'search_ai', owners: { ALICE: 1 } },
    { id: 'search-b', category: 'search_ai', owners: { BOB: 1 } },
  ]
  m.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT name AS username'))
      return [
        { username: 'ALICE', display_name: 'Alice Example' },
        { username: 'BOB', display_name: 'Bob Example' },
      ]
    if (sql.includes('SELECT id,category,owners')) return works
    return []
  })
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? {
          payload: {
            asOf: '2026-09-18T00:00:00Z',
            sections: [
              {
                ...s('photo_rest', 0),
                rows: [
                  { DAY: '2026-09-18', WORK_ID: 'photo', CREDITS: 2 },
                  { DAY: '2026-09-18', WORK_ID: 'search-a', CREDITS: 3 },
                  { DAY: '2026-09-18', WORK_ID: 'search-b', PURPOSE: 'search_ai', CREDITS: 5 },
                  { DAY: '2026-09-18', WORK_ID: 'search-a', CREDITS: null },
                ],
              },
            ],
          },
        }
      : null,
  )
  const all = await personalCosts(owner, 'all')
  expect(all.services.find((s) => s.key === 'photo_rest')?.credits).toBe(2)
  expect(all.services.find((s) => s.key === 'search_rest')?.credits).toBe(8)
  expect(all.subtotalUsd).toBe(20)
  expect(all.daily.at(-1)).toMatchObject({ photo_rest: 4, search_rest: 16, usd: 20 })
  const alice = await personalCosts(viewer, null)
  expect(alice.services.find((s) => s.key === 'search_rest')?.credits).toBe(3)
  expect(alice.daily.at(-1)).toMatchObject({ photo_rest: 4, search_rest: 6, usd: 10 })
  expect(alice.restUsageMissing).toBe(true)
})

it('counts app cloud services once, separately from warehouse cloud totals, and leaves personal shares unavailable', async () => {
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('FROM cost_work WHERE')
      ? [{ id: 'production', category: 'warehouse', owners: { ALICE: 1 } }]
      : [],
  )
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? {
          payload: {
            asOf: '2026-09-18T00:00:00Z',
            sections: [
              {
                ...s('personal_warehouse', 2),
                rows: [
                  {
                    DAY: '2026-09-18',
                    WORK_ID: 'production',
                    CREDITS: 2,
                    CLOUD_SERVICES_CREDITS: 50,
                  },
                ],
              },
              {
                ...s('cloud_services', 3),
                rows: [
                  { DAY: '2026-09-18', WORK_ID: 'production', CREDITS: 3 },
                  { DAY: '2026-09-18', WORK_ID: 'isolated-test', CREDITS: 1000 },
                ],
              },
              { ...s('personal_ai', 0), rows: [] },
            ],
          },
        }
      : null,
  )
  const report = await personalCosts(owner, 'all')
  expect(report.services.find((s) => s.key === 'cloud_services')?.credits).toBe(3)
  expect(report.subtotalUsd).toBe(10)
  expect(report.daily.at(-1)).toMatchObject({ cloud_services: 6, warehouse: 4, usd: 10 })
  expect(report.services.some((s) => s.key === 'search_ai')).toBe(false)
  const personal = await personalCosts(viewer, null)
  expect(personal.services.find((s) => s.key === 'cloud_services')?.credits).toBeNull()
  expect(personal.daily.every((d) => (d as Record<string, unknown>).cloud_services === null)).toBe(
    true,
  )
})

it('shows missing cloud-services metering as unavailable, not zero', async () => {
  m.query.mockResolvedValue([])
  m.one.mockResolvedValue(null)
  const report = await personalCosts(owner, 'all')
  expect(report.services.find((s) => s.key === 'cloud_services')?.credits).toBeNull()
})

it('uses Eastern calendar dates for new reports and flags legacy UTC caches', async () => {
  m.query.mockResolvedValue([])
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? {
          payload: { asOf: '2026-10-23T02:00:00Z', timeZone: 'America/New_York', sections: [] },
        }
      : null,
  )
  const eastern = await personalCosts(owner, 'all')
  expect(eastern.periodEnd).toBe('2026-10-22')
  expect(eastern.timezoneRefreshNeeded).toBe(false)
  expect(eastern.daily.at(-1)?.day).toBe('2026-10-22')
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? {
          payload: { asOf: '2026-10-23T02:00:00Z', sections: [] },
        }
      : null,
  )
  const legacy = await personalCosts(owner, 'all')
  expect(legacy.periodEnd).toBe('2026-10-23')
  expect(legacy.timezoneRefreshNeeded).toBe(true)
})

it('allocates shared costs only for membership time, including signup/deletion and DST', () => {
  const members = [
    { username: 'old', joined_at: '2026-01-01T00:00:00Z' },
    { username: 'new', joined_at: '2026-10-30T16:00:00Z' },
  ]
  expect(
    membershipShare(members, 'new', '2026-10-29', 'America/New_York', '2026-10-31T04:00:00Z'),
  ).toBe(0)
  expect(
    membershipShare(members, 'new', '2026-10-30', 'America/New_York', '2026-10-31T04:00:00Z'),
  ).toBeCloseTo(1 / 3)
  expect(
    membershipShare(members, 'new', '2026-10-30', 'America/New_York', '2026-10-30T16:00:00Z'),
  ).toBe(0)
  const dst = [members[0], { username: 'new', joined_at: '2026-11-01T17:00:00Z' }]
  expect(
    membershipShare(dst, 'new', '2026-11-01', 'America/New_York', '2026-11-02T05:00:00Z'),
  ).toBeCloseTo(12 / 37)
  expect(
    membershipShare(
      [{ ...members[0], deleted_at: '2026-10-29T00:00:00Z' }],
      'old',
      '2026-10-30',
      'America/New_York',
      '2026-10-31T04:00:00Z',
    ),
  ).toBe(0)
})

it('uses only configured production estimates, prorates new members, and reconciles daily costs', async () => {
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('SELECT name AS username')
      ? [
          { username: 'ALICE', display_name: 'Alice', joined_at: '2026-01-01T00:00:00Z' },
          { username: 'BOB', display_name: 'Bob', joined_at: '2026-10-31T10:00:00Z' },
        ]
      : [],
  )
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? {
          payload: {
            asOf: '2026-10-31T16:00:00Z',
            timeZone: 'America/New_York',
            sections: [s('runtime', 999999), s('postgres', 999999)],
          },
          refreshed_at: '2026-10-31T16:00:00Z',
        }
      : null,
  )
  const alice = await personalCosts(owner, 'ALICE')
  const bob = await personalCosts(owner, 'BOB')
  const all = await personalCosts(owner, 'all')
  for (const key of ['runtime', 'postgres']) {
    const amount = (r: typeof all) => r.services.find((s) => s.key === key)!.usd!
    expect(amount(all)).toBeGreaterThan(0)
    expect(amount(all)).toBeLessThan(50)
    expect(amount(alice) + amount(bob)).toBeCloseTo(amount(all), 10)
    const dailyTotal = all.daily.reduce(
      (sum, row) => sum + Number((row as Record<string, unknown>)[key]),
      0,
    )
    expect(dailyTotal).toBeCloseTo(amount(all), 10)
  }
  const last = bob.daily.at(-1) as Record<string, unknown>
  expect(last.postgres).toBeCloseTo((12 * 0.0136 * 2) / 3, 10)
  expect(last.runtime).toBeCloseTo((12 * 0.0297 * 2) / 3, 10)
  expect(bob.daily.at(-2)).toMatchObject({ postgres: 0, runtime: 0 })
})

it('allocates only identified production pools by membership time in totals and charts', async () => {
  const { COST_POOLS } = await import('@/lib/costs/cost-pools')
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('SELECT name AS username')
      ? [
          { username: 'ALICE', joined_at: '2026-09-01T00:00:00Z' },
          { username: 'BOB', joined_at: '2026-09-18T12:00:00Z' },
          { username: 'CAROL', joined_at: '2026-09-20T00:00:00Z' },
        ]
      : [],
  )
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? {
          payload: {
            asOf: '2026-09-19T00:00:00Z',
            sections: COST_POOLS.map(({ key, pools }) => ({
              ...s(key, 0),
              rows: [
                { DAY: '2026-09-18', COMPUTE_POOL_NAME: pools[0], CREDITS: 12 },
                {
                  DAY: '2026-09-18',
                  COMPUTE_POOL_NAME: 'STILLMARK_LOADTEST_BASELINE_UPLOAD',
                  CREDITS: 999,
                },
              ],
            })),
          },
        }
      : null,
  )
  const all = await personalCosts(owner, 'all')
  const alice = await personalCosts(viewer, null)
  const bob = await personalCosts(owner, 'BOB')
  const carol = await personalCosts(owner, 'CAROL')
  for (const { key } of COST_POOLS) {
    expect(all.services.find((s) => s.key === key)?.credits).toBe(12)
    expect(alice.services.find((s) => s.key === key)?.credits).toBe(8)
    expect(bob.services.find((s) => s.key === key)?.credits).toBe(4)
    expect(carol.services.find((s) => s.key === key)?.credits).toBe(0)
    expect(
      alice.daily.reduce((sum, d) => sum + Number((d as Record<string, unknown>)[key] ?? 0), 0),
    ).toBe(16)
  }
  expect(all.subtotalUsd).toBe(72)
  expect(alice.subtotalUsd! + bob.subtotalUsd!).toBe(all.subtotalUsd)
})

it('combines historical SQL descriptions and REST exactly once without an obsolete SQL row', async () => {
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('SELECT id,category,owners')
      ? [
          { id: 'sql', category: 'photo_ai', owners: { ALICE: 1 } },
          { id: 'rest', category: 'photo_ai', owners: { ALICE: 1 } },
        ]
      : [],
  )
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? {
          payload: {
            asOf: '2026-09-19T00:00:00Z',
            sections: [
              { ...s('personal_ai', 0), rows: [{ DAY: '2026-09-18', WORK_ID: 'sql', CREDITS: 2 }] },
              { ...s('photo_rest', 0), rows: [{ DAY: '2026-09-18', WORK_ID: 'rest', CREDITS: 3 }] },
            ],
          },
        }
      : null,
  )
  const report = await personalCosts(viewer, null)
  expect(report.services.find((s) => s.key === 'photo_ai')).toBeUndefined()
  expect(report.services.find((s) => s.key === 'photo_rest')).toMatchObject({
    label: 'Photo AI',
    credits: 5,
  })
  expect(report.subtotalUsd).toBe(10)
  expect(report.daily.reduce((total, day) => total + (day.usd ?? 0), 0)).toBe(10)
})

it('loads a large saved ledger for independent callers without exposing diagnostic account sections', async () => {
  const rows = Array.from({ length: 50000 }, (_, i) => ({
    DAY: '2026-11-10',
    WORK_ID: `w${i}`,
    CREDITS: 0.000001,
  }))
  const works = rows.map((r) => ({ id: r.WORK_ID, category: 'photo_ai', owners: { ALICE: 1 } }))
  m.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT name AS username')) return [{ username: 'ALICE' }]
    if (sql.includes('SELECT id,category,owners')) return works
    return []
  })
  m.one.mockImplementation(async (sql: string) =>
    sql.includes('SELECT payload')
      ? {
          payload: {
            asOf: '2026-11-10T19:00:00Z',
            timeZone: 'America/New_York',
            sections: [
              { key: 'cloud_services', label: 'App cloud services', rows, error: null },
              { key: 'photo_rest', label: 'Photo AI', rows, error: null },
              {
                key: 'rest_usage',
                label: 'Private diagnostic ledger',
                rows: [{ CREDITS: 999999 }],
                error: 'private failure',
                stale: true,
              },
            ],
          },
          refreshed_at: '2026-11-10T19:00:00Z',
        }
      : null,
  )
  const first = await personalCosts(owner, null)
  const second = await personalCosts(owner, null)
  expect(second).toEqual(first)
  expect(second.services.find((s) => s.key === 'cloud_services')?.credits).toBeCloseTo(0.05, 8)
  expect(second.services.find((s) => s.key === 'photo_rest')?.credits).toBeCloseTo(0.05, 8)
  expect(second.staleSources).toEqual([])
  expect(JSON.stringify(second)).not.toContain('Private diagnostic ledger')
  expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThan(20000)
  const member = await personalCosts(viewer, null)
  expect(member.users).toEqual([])
  expect(member.services.find((s) => s.key === 'cloud_services')?.credits).toBeNull()
  expect(member.services.find((s) => s.key === 'photo_rest')?.credits).toBeCloseTo(0.05, 8)
})
