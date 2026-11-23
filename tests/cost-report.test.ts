import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ query: vi.fn(), one: vi.fn(), snow: vi.fn() }))
vi.mock('@/lib/postgres', () => ({
  pgQuery: m.query,
  pgQueryOne: m.one,
  pgTransaction: async (f: () => unknown) => f(),
  withAdvisoryLock: async (_k: string, f: () => unknown) => f(),
}))
vi.mock('@/lib/snowflake', () => ({ querySnowflakeLongRunning: m.snow }))
import {
  COST_QUERIES,
  costRefreshProgress,
  costWindowStart,
  refreshCostReport,
  storedCostReport,
} from '../lib/costs/cost-report'

beforeEach(() => {
  vi.resetAllMocks()
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('RETURNING name') ? [{ name: 'costs-progress' }] : [],
  )
})
it('serves cached reporting and storage snapshots without warehouse queries', async () => {
  m.one
    .mockResolvedValueOnce({ active_bytes: '100', trash_bytes: '10', media_count: 2 })
    .mockResolvedValueOnce({ payload: { sections: [] } })
  const r = await storedCostReport()
  expect(r.storage?.media_count).toBe(2)
  expect(m.snow).not.toHaveBeenCalled()
})
it('rate-limits manual reporting before waking Snowflake', async () => {
  m.one.mockResolvedValue({ one: 1 })
  await expect(refreshCostReport()).rejects.toMatchObject({ status: 429 })
  expect(m.snow).not.toHaveBeenCalled()
})
it('fetches each usage section only on explicit refresh and caches it', async () => {
  m.one.mockResolvedValue(null)
  m.snow.mockResolvedValue([{ DAY: '2026-09-15', CREDITS: 1 }])
  const r = await refreshCostReport()
  expect(r.sections).toHaveLength(COST_QUERIES.length + 3)
  expect(m.snow).toHaveBeenCalledTimes(COST_QUERIES.length)
  expect(r.days).toBe(30)
  expect(r.timeZone).toBe('America/New_York')
  for (const section of COST_QUERIES.filter((s) => s.key !== 'activity'))
    expect(section.sql).toContain(costWindowStart(29))
  expect(m.query.mock.calls.at(-1)?.[0]).toContain('UPDATE app_reports SET payload')
})

it('never uses SQL text or model names for live attribution', () => {
  for (const section of COST_QUERIES) {
    expect(section.sql).not.toContain('QUERY_TEXT')
    if (section.key !== 'rest_usage') expect(section.sql).not.toContain('MODEL_NAME')
  }
  const ai = COST_QUERIES.find((s) => s.key === 'ai')!.sql
  expect(ai).toContain('a.QUERY_TAG')
  expect(ai).toContain('DYNAMIC_TABLE_REFRESH_HISTORY')
})
it('loads immutable historical classifications and derives personal AI from the same snapshot', async () => {
  m.one.mockResolvedValue(null)
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('FROM cost_ai_history')
      ? [{ query_id: 'q1', function_name: 'AI_COMPLETE', kind: 'video_ai' }]
      : sql.includes('RETURNING name')
        ? [{ name: 'costs-progress' }]
        : [],
  )
  m.snow.mockResolvedValue([
    { QUERY_ID: 'q1', FUNCTION_NAME: 'AI_COMPLETE', WORK_ID: 'w1', CREDITS: 2 },
  ])
  const report = await refreshCostReport()
  const ai = report.sections.find((s) => s.key === 'ai')!
  expect(ai.rows[0].VERIFIED_KIND).toBe('video_ai')
  expect(report.sections.find((s) => s.key === 'personal_ai')!.rows).toEqual(ai.rows)
})

it('meters the face pool separately from video GPU usage and Cortex AI', async () => {
  const { deployment } = await import('../config/deployment.mjs')
  const faces = COST_QUERIES.find((s) => s.key === 'faces')!
  expect(faces.sql).toContain('SNOWPARK_CONTAINER_SERVICES_HISTORY')
  expect(faces.sql).toContain(
    `COMPUTE_POOL_NAME IN ('${deployment.FACE_POOL}','${deployment.SEARCH_POOL}')`,
  )
  expect(COST_QUERIES.find((s) => s.key === 'gpu')!.sql).not.toContain(deployment.FACE_POOL)
})

it('reconciles photo Agent requests by metered request IDs and keeps account usage out of the subtotal', async () => {
  m.one.mockResolvedValue(null)
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('FROM cost_rest_requests')
      ? [
          {
            REQUEST_ID: 'local',
            PROVIDER_REQUEST_ID: 'agent-id',
            WORK_ID: 'w1',
            PRICING_VERSION: 'agents-unverified',
            CREDITS: null,
          },
        ]
      : sql.includes('RETURNING name')
        ? [{ name: 'costs-progress' }]
        : [],
  )
  m.snow.mockImplementation(async (sql: string) =>
    sql.includes('CORTEX_AGENT_USAGE_HISTORY')
      ? [
          { REQUEST_ID: 'agent-id', CREDITS: 0.004, BASIS: 'Snowflake metered Agents credits' },
          { REQUEST_ID: 'other', CREDITS: 20 },
        ]
      : [],
  )
  const report = await refreshCostReport()
  expect(report.sections.find((s) => s.key === 'photo_rest')!.rows).toMatchObject([
    { CREDITS: 0.004, WORK_ID: 'w1', RECONCILED: true },
  ])
})

it('reports OpenAI requests in dollars, apart from the Snowflake credit reconciliation', async () => {
  m.query.mockImplementation(async (sql: string) =>
    sql.includes('FROM cost_rest_requests')
      ? [
          { REQUEST_ID: 'a', WORK_ID: 'w1', PRICING_VERSION: 'openai-usd-2026-11-23', USD: 0.007 },
          { REQUEST_ID: 'b', WORK_ID: 'w2', PRICING_VERSION: '2026-10-15-table-6b', CREDITS: 0.5 },
        ]
      : sql.includes('RETURNING name')
        ? [{ name: 'costs-progress' }]
        : [],
  )
  m.snow.mockResolvedValue([])
  const report = await refreshCostReport()
  expect(report.sections.find((s) => s.key === 'photo_openai')!.rows).toMatchObject([
    { REQUEST_ID: 'a', USD: 0.007 },
  ])
  // An OpenAI row has no credits; left in this section it would read as a missing charge.
  expect(report.sections.find((s) => s.key === 'photo_rest')!.rows).toMatchObject([
    { REQUEST_ID: 'b', CREDITS: 0.5 },
  ])
})

it('includes warehouse-free app cloud services without including unrelated account users', () => {
  const sql = COST_QUERIES.find((s) => s.key === 'cloud_services')!.sql
  expect(sql).toContain('SUM(CREDITS_USED_CLOUD_SERVICES)')
  expect(sql).toContain("WHERE QUERY_TAG LIKE 'personal-photos:%'")
  expect(sql).toContain('AS WORK_ID')
  expect(sql).not.toContain('USER_NAME=CURRENT_USER()')
  expect(sql).not.toContain('WAREHOUSE_NAME')
  expect(sql).not.toContain('EXECUTION_STATUS')
})

it('uses hourly serving usage so Eastern midnight does not shift a whole UTC day', () => {
  const query = COST_QUERIES.find((s) => s.key === 'search')!.sql
  expect(query).toContain('CORTEX_SEARCH_SERVING_USAGE_HISTORY')
  expect(query).toContain("CONVERT_TIMEZONE('America/New_York',START_TIME)")
  expect(query).not.toContain('USAGE_DATE')
})

it('keeps cached source values on failure and records per-source progress in Postgres', async () => {
  m.one.mockResolvedValueOnce(null).mockResolvedValueOnce({
    payload: {
      asOf: '2026-10-24T12:00:00Z',
      sections: [{ key: 'gpu', label: 'GPU', rows: [{ CREDITS: 7 }], error: null }],
    },
  })
  m.snow.mockRejectedValue(new Error('source unavailable'))
  const report = await refreshCostReport()
  expect(report.sections.find((s) => s.key === 'gpu')).toMatchObject({
    rows: [{ CREDITS: 7 }],
    stale: true,
    error: null,
    lastSuccessAt: '2026-10-24T12:00:00Z',
  })
  const progress = m.query.mock.calls.filter((c) => c[0].includes('RETURNING name'))
  expect(progress.length).toBe((COST_QUERIES.length + 1) * 2 + 1)
  const last = JSON.parse(progress.at(-1)![1][0])
  expect(last.sources.find((s: { key: string }) => s.key === 'gpu').status).toBe('failed')
  expect(last.sources.find((s: { key: string }) => s.key === 'photo_rest').status).toBe('complete')
})

it('reads manual refresh progress without Snowflake queries and reconciles abandoned ownership', async () => {
  m.one.mockResolvedValue({ payload: { sources: [] } })
  expect(await costRefreshProgress()).toEqual({ sources: [], asOf: null })
  expect(m.snow).not.toHaveBeenCalled()
  expect(m.query.mock.calls[0][0]).toContain("'status','interrupted'")
})

it('does not collect unused account-wide hosting or Postgres totals', () => {
  expect(COST_QUERIES.some((q) => q.key === 'runtime' || q.key === 'postgres')).toBe(false)
})

it('collects upload metering for the dedicated production pool only', () => {
  const upload = COST_QUERIES.find((section) => section.key === 'uploads')!
  expect(upload.sql).toContain("COMPUTE_POOL_NAME IN ('PERSONAL_PHOTOS_UPLOAD_CPU')")
  expect(upload.sql).toContain('GROUP BY 1,2')
  expect(upload.sql).toContain("CONVERT_TIMEZONE('America/New_York',START_TIME)")
})

it('finishes and persists refresh after the initiating page disconnects', async () => {
  const { databaseContext, databaseSignal } = await import('../lib/database/database-context')
  const controller = new AbortController()
  m.one.mockResolvedValue(null)
  m.snow.mockImplementation(async () => {
    controller.abort()
    expect(databaseSignal()).toBeUndefined()
    return []
  })
  const result = await databaseContext.run({ kind: 'request', signal: controller.signal }, () =>
    refreshCostReport(),
  )
  expect(controller.signal.aborted).toBe(true)
  expect(result.asOf).toBeTruthy()
  expect(m.query.mock.calls.at(-1)?.[0]).toContain('UPDATE app_reports SET payload')
  expect(m.snow).toHaveBeenCalledTimes(COST_QUERIES.length)
})
it('reads completion even when progress has not been recorded', async () => {
  m.one.mockResolvedValue({ payload: null, as_of: 'new' })
  expect(await costRefreshProgress()).toEqual({
    startedAt: '',
    updatedAt: '',
    sources: [],
    asOf: 'new',
  })
  expect(m.one.mock.calls[0][0]).not.toContain("payload FROM app_reports WHERE name='costs'")
})
