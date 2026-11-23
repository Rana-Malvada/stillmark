import { COST_POOLS } from './cost-pools'
import { randomUUID } from 'node:crypto'
import {
  type CachedCostSection,
  type CostRefreshProgress,
  retainCostSection,
} from './cost-refresh-state'
import { COST_TIME_ZONE } from './cost-timezone'
import { reconcileRestUsage, recordedRestUsage } from '../snowflake/cortex-rest-reconcile'
import { deployment } from '../../config/deployment.mjs'
import { withServiceDatabase } from '../database/database-context'
import { aiCostPurpose } from '../ai-cost-purpose'
import { pgQuery, pgQueryOne, pgTransaction, withAdvisoryLock } from '@/lib/postgres'
import { querySnowflakeLongRunning } from '@/lib/snowflake'
import { HttpError } from '@/lib/http'

// Construct midnight in the target day's zone, not today's fixed UTC offset (DST).
export function costWindowStart(daysAgo: number) {
  const day = `DATEADD('day',-${daysAgo},TO_DATE(CONVERT_TIMEZONE('America/New_York',CURRENT_TIMESTAMP())))`
  return `TIMESTAMP_TZ_FROM_PARTS(YEAR(${day}),MONTH(${day}),DAY(${day}),0,0,0,0,'America/New_York')`
}
export const COST_QUERIES = [
  {
    key: 'rest_usage',
    label: 'Cortex REST — account usage (not added again to app totals)',
    sql: `SELECT TO_CHAR(CONVERT_TIMEZONE('America/New_York',START_TIME)::DATE,'YYYY-MM-DD') AS DAY,
 REQUEST_ID,MODEL_NAME,TOKENS,TOKENS_GRANULAR,OBJECT_CONSTRUCT_KEEP_NULL(*) AS USAGE_RECORD
 FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_REST_API_USAGE_HISTORY
 WHERE START_TIME>=${costWindowStart(29)}
 ORDER BY START_TIME,REQUEST_ID`,
  },
  {
    key: 'agent_usage',
    label: 'Cortex Agents — account usage (reconciled by request ID only)',
    sql: `SELECT TO_CHAR(CONVERT_TIMEZONE('America/New_York',START_TIME)::DATE,'YYYY-MM-DD') AS DAY,
 REQUEST_ID,TOKEN_CREDITS AS CREDITS,'Snowflake metered Agents credits' AS BASIS
 FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY
 WHERE START_TIME>=${costWindowStart(29)}
 ORDER BY START_TIME,REQUEST_ID`,
  },
  ...COST_POOLS.map(({ key, label, pools }) => ({
    key,
    label,
    sql: `SELECT TO_CHAR(CONVERT_TIMEZONE('America/New_York',START_TIME)::DATE,'YYYY-MM-DD') AS DAY,COMPUTE_POOL_NAME,SUM(CREDITS_USED) AS CREDITS
 FROM SNOWFLAKE.ACCOUNT_USAGE.SNOWPARK_CONTAINER_SERVICES_HISTORY
 WHERE COMPUTE_POOL_NAME IN (${pools.map((name) => `'${name}'`).join(',')})
 AND START_TIME>=${costWindowStart(29)} GROUP BY 1,2 ORDER BY 1,2`,
  })),
  {
    key: 'warehouse',
    label: `${deployment.WAREHOUSE} — all workloads`,
    sql: `SELECT TO_CHAR(CONVERT_TIMEZONE('America/New_York',START_TIME)::DATE,'YYYY-MM-DD') AS DAY,
  SUM(CREDITS_USED_COMPUTE) AS COMPUTE_CREDITS,SUM(CREDITS_USED_CLOUD_SERVICES) AS CLOUD_SERVICES_CREDITS
  FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY WHERE WAREHOUSE_NAME='${deployment.WAREHOUSE}' AND START_TIME>=${costWindowStart(29)} GROUP BY 1 ORDER BY 1`,
  },
  {
    key: 'cloud_services',
    label: 'App cloud services — before billing adjustments',
    sql: `SELECT TO_CHAR(CONVERT_TIMEZONE('America/New_York',START_TIME)::DATE,'YYYY-MM-DD') AS DAY,
 SUBSTR(QUERY_TAG,17) AS WORK_ID,SUM(CREDITS_USED_CLOUD_SERVICES) AS CREDITS
 FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
 WHERE QUERY_TAG LIKE 'personal-photos:%'
 AND START_TIME>=${costWindowStart(29)}
 GROUP BY 1,2 ORDER BY 1,2`,
  },
  {
    key: 'ai',
    label: `AI processing by task on ${deployment.WAREHOUSE}`,
    sql: `SELECT TO_CHAR(CONVERT_TIMEZONE('America/New_York',a.START_TIME)::DATE,'YYYY-MM-DD') AS DAY,
 a.QUERY_ID,a.FUNCTION_NAME,
 IFF(a.QUERY_TAG LIKE 'personal-photos:%',SUBSTR(a.QUERY_TAG,17),NULL) AS WORK_ID,
 CASE WHEN a.FUNCTION_NAME ILIKE '%EMBED%' THEN
  CASE WHEN r.DATABASE_NAME='${deployment.DATABASE}' AND r.SCHEMA_NAME='${deployment.DATA_SCHEMA}'
   AND (STARTSWITH(r.NAME,'_CORTEX_SEARCH_SOURCE_${deployment.PHOTO_SEARCH_SERVICE}_') OR STARTSWITH(r.NAME,'_CORTEX_SEARCH_SOURCE_${deployment.EVENT_SEARCH_SERVICE}_')) THEN 'search_indexing'
   WHEN h.QUERY_TYPE LIKE 'REFRESH_DYNAMIC_TABLE%' AND r.QUERY_ID IS NULL THEN 'pending_embedding'
   WHEN h.QUERY_ID IS NULL AND r.QUERY_ID IS NULL THEN 'pending_embedding'
   ELSE 'search_ai' END ELSE NULL END AS SOURCE_KIND,
 SUM(a.CREDITS) AS CREDITS
 FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AI_FUNCTIONS_USAGE_HISTORY a
 LEFT JOIN (SELECT DISTINCT QUERY_ID,NAME,DATABASE_NAME,SCHEMA_NAME FROM SNOWFLAKE.ACCOUNT_USAGE.DYNAMIC_TABLE_REFRESH_HISTORY
  WHERE REFRESH_START_TIME>=${costWindowStart(31)}) r ON r.QUERY_ID=a.QUERY_ID AND a.FUNCTION_NAME ILIKE '%EMBED%'
 LEFT JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY h ON h.QUERY_ID=a.QUERY_ID AND a.FUNCTION_NAME ILIKE '%EMBED%'
  AND h.START_TIME>=${costWindowStart(31)}
 WHERE a.START_TIME>=${costWindowStart(29)}
 AND a.WAREHOUSE_ID IN (SELECT DISTINCT WAREHOUSE_ID FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY WHERE WAREHOUSE_NAME='${deployment.WAREHOUSE}' AND START_TIME>=${costWindowStart(29)})
 GROUP BY 1,2,3,4,5 ORDER BY 1,2,3`,
  },
  {
    key: 'search',
    label: 'Photo and album search availability only',
    sql: `SELECT TO_CHAR(CONVERT_TIMEZONE('America/New_York',START_TIME)::DATE,'YYYY-MM-DD') AS DAY,SERVICE_NAME,SUM(CREDITS) AS CREDITS
 FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_SEARCH_SERVING_USAGE_HISTORY WHERE DATABASE_NAME='${deployment.DATABASE}' AND SCHEMA_NAME='${deployment.DATA_SCHEMA}'
 AND SERVICE_NAME IN ('${deployment.PHOTO_SEARCH_SERVICE}','${deployment.EVENT_SEARCH_SERVICE}')
 AND START_TIME>=${costWindowStart(29)} GROUP BY 1,2 ORDER BY 1,2`,
  },
  {
    key: 'activity',
    label: `Recent ${deployment.WAREHOUSE} queries — all workloads (reporting may lag)`,
    sql: `SELECT START_TIME,QUERY_TYPE,EXECUTION_STATUS,TOTAL_ELAPSED_TIME AS ELAPSED_MS,
  QUERY_TYPE AS ACTIVITY
  FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY WHERE WAREHOUSE_NAME='${deployment.WAREHOUSE}' AND START_TIME>=DATEADD('day',-1,CURRENT_TIMESTAMP()) ORDER BY START_TIME DESC LIMIT 30`,
  },
  {
    key: 'search_indexing',
    label: 'Search embedding credits',
    sql: `SELECT TO_CHAR(CONVERT_TIMEZONE('America/New_York',USAGE_DATE)::DATE,'YYYY-MM-DD') AS DAY,SERVICE_NAME,SUM(CREDITS) AS CREDITS
 FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_SEARCH_DAILY_USAGE_HISTORY WHERE DATABASE_NAME='${deployment.DATABASE}' AND SCHEMA_NAME='${deployment.DATA_SCHEMA}'
 AND SERVICE_NAME IN ('${deployment.PHOTO_SEARCH_SERVICE}','${deployment.EVENT_SEARCH_SERVICE}') AND CONSUMPTION_TYPE='EMBED_TEXT_TOKENS'
 AND USAGE_DATE>=${costWindowStart(29)} GROUP BY 1,2 ORDER BY 1,2`,
  },
  {
    key: 'personal_warehouse',
    label: 'Attributed app warehouse compute',
    sql: `SELECT TO_CHAR(CONVERT_TIMEZONE('America/New_York',START_TIME)::DATE,'YYYY-MM-DD') AS DAY,
 SUBSTR(QUERY_TAG,17) AS WORK_ID,SUM(CREDITS_ATTRIBUTED_COMPUTE) AS CREDITS FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY
 WHERE QUERY_TAG LIKE 'personal-photos:%' AND WAREHOUSE_NAME='${deployment.WAREHOUSE}'
 AND START_TIME>=${costWindowStart(29)} GROUP BY 1,2 ORDER BY 1,2`,
  },
]
const REFRESH_LOCK = 'cost-report'
const INTERRUPTED =
  'The refresh was interrupted. Your previous report is unchanged. Refresh again to retry.'

/** Call only while holding REFRESH_LOCK. Acquiring that session lock proves no
 * other refresh still owns it, including after process/connection loss. Legacy
 * progress without an explicit status is reconciled by publication time. */
async function interruptAbandonedRefresh() {
  await pgQuery(
    `UPDATE app_reports SET payload=payload || jsonb_build_object(
       'status','interrupted','error',$1::text,'updatedAt',now())
     WHERE name='costs-progress' AND (
       payload->>'status'='running' OR
       (payload->>'status' IS NULL AND payload->>'startedAt' IS NOT NULL
        AND NOT EXISTS(SELECT FROM app_reports report WHERE report.name='costs'
          AND report.refreshed_at >= (app_reports.payload->>'startedAt')::timestamptz)))`,
    [INTERRUPTED],
  )
}

async function refreshCostReportService() {
  const result = await withAdvisoryLock(REFRESH_LOCK, async () => {
    await interruptAbandonedRefresh()
    const recent = await pgQueryOne(
      `SELECT 1 FROM app_reports WHERE name='costs' AND attempted_at>NOW()-INTERVAL '15 minutes'
       AND NOT EXISTS(SELECT FROM app_reports p WHERE p.name='costs-progress'
         AND p.payload->>'status' IN ('interrupted','failed'))`,
    )
    if (recent)
      throw new HttpError(
        429,
        'Cost data was refreshed recently. Wait 15 minutes before another refresh.',
      )
    const previous = await pgQueryOne<{
      payload: { sections?: CachedCostSection[]; asOf?: string }
    }>("SELECT payload FROM app_reports WHERE name='costs'")
    const sections: CachedCostSection[] = []
    const progress: CostRefreshProgress = {
      runId: randomUUID(),
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sources: [...COST_QUERIES, { key: 'photo_rest', label: 'App REST usage reconciliation' }].map(
        (s) => ({ key: s.key, label: s.label, status: 'waiting' }),
      ),
    }
    // Attempt time and ownership appear together. A crash cannot leave a fresh
    // cooldown with no recoverable progress record. Keep the last report intact.
    await pgTransaction(async () => {
      await pgQuery(
        "INSERT INTO app_reports(name) VALUES('costs') ON CONFLICT(name) DO UPDATE SET attempted_at=NOW()",
      )
      await pgQuery(
        "INSERT INTO app_reports(name,payload,refreshed_at) VALUES('costs-progress',$1::jsonb,NOW()) ON CONFLICT(name) DO UPDATE SET payload=EXCLUDED.payload,refreshed_at=NOW()",
        [JSON.stringify(progress)],
      )
    })
    const persistProgress = async () => {
      const saved = await pgQuery(
        `UPDATE app_reports SET payload=$1::jsonb,refreshed_at=now()
         WHERE name='costs-progress' AND payload->>'runId'=$2 AND payload->>'status'='running'
         RETURNING name`,
        [JSON.stringify(progress), progress.runId],
      )
      if (!saved.length)
        throw new HttpError(
          409,
          'This refresh no longer owns the saved progress. Check the latest report.',
        )
    }
    const updateProgress = async (
      key: string,
      status: CostRefreshProgress['sources'][number]['status'],
    ) => {
      progress.sources.find((s) => s.key === key)!.status = status
      progress.updatedAt = new Date().toISOString()
      await persistProgress()
    }
    const retain = () => {
      const current = sections[sections.length - 1]
      sections[sections.length - 1] = current.error
        ? retainCostSection(
            current,
            previous?.payload?.sections?.find((s) => s.key === current.key),
            previous?.payload?.asOf,
          )
        : { ...current, lastSuccessAt: new Date().toISOString() }
    }
    try {
      // Run sequentially to avoid a burst of warehouse queries from a single refresh.
      for (const item of COST_QUERIES) {
        await updateProgress(item.key, 'running')
        try {
          const rows = await querySnowflakeLongRunning(item.sql, { maxWaitMs: 60000 })
          if (item.key === 'ai') {
            const verified = await pgQuery<{
              query_id: string
              function_name: string
              kind: string
            }>(
              'SELECT query_id,function_name,kind FROM cost_ai_history WHERE query_id=ANY($1::text[])',
              [[...new Set(rows.map((r) => String(r.QUERY_ID)))]],
            )
            const byQuery = new Map(
              verified.map((r) => [JSON.stringify([r.query_id, r.function_name]), r.kind]),
            )
            for (const row of rows)
              row.VERIFIED_KIND =
                byQuery.get(JSON.stringify([row.QUERY_ID, row.FUNCTION_NAME])) ?? null
          }
          sections.push({
            key: item.key,
            label: item.label,
            rows: item.key === 'rest_usage' ? rows.map(recordedRestUsage) : rows,
            error: null,
          })
        } catch (error) {
          console.error('[cost-report]', item.key, error)
          sections.push({
            key: item.key,
            label: item.label,
            rows: [],
            error:
              'Usage unavailable. The account may not expose this view or the service role may lack permission.',
          })
        }
        await updateProgress(item.key, sections[sections.length - 1].error ? 'failed' : 'complete')
        retain()
      }
      await updateProgress('photo_rest', 'running')
      try {
        const rows = await pgQuery(
          `SELECT to_char(r.created_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS "DAY",
         r.id AS "REQUEST_ID",r.provider_request_id AS "PROVIDER_REQUEST_ID",r.work_id AS "WORK_ID",r.model AS "MODEL_NAME",
         r.estimated_credits::float8 AS "CREDITS",r.status AS "STATUS",
         r.pricing_version AS "PRICING_VERSION", w.category AS "PURPOSE",
         (r.usage->>'interpretation_ms')::int AS "INTERPRETATION_MS",
         (r.usage->>'estimated_usd')::float8 AS "USD"
         FROM cost_rest_requests r JOIN cost_work w ON w.id=r.work_id WHERE r.created_at>=(date_trunc('day',now() AT TIME ZONE 'America/New_York')-interval '29 days') AT TIME ZONE 'America/New_York'
         ORDER BY r.created_at`,
        )
        // OpenAI requests are not Snowflake usage: keep them out of the credit
        // reconciliation and report them in dollars on their own line.
        const direct = (r: Record<string, unknown>) =>
          String(r.PRICING_VERSION).startsWith('openai-')
        sections.push({
          key: 'photo_openai',
          label: 'AI — OpenAI direct (response tokens × published rate)',
          rows: rows.filter(direct),
          error: null,
        })
        sections.push({
          key: 'photo_rest',
          label: 'AI — Cortex REST (reconciled usage)',
          rows: reconcileRestUsage(
            rows.filter((r) => !direct(r)),
            sections.find((s) => s.key === 'rest_usage')?.rows ?? [],
            sections.find((s) => s.key === 'agent_usage')?.rows ?? [],
          ),
          error: null,
        })
      } catch {
        sections.push({
          key: 'photo_rest',
          label: 'AI — Cortex REST estimates',
          rows: [],
          error: 'REST usage unavailable; totals are incomplete.',
        })
      }
      await updateProgress(
        'photo_rest',
        sections[sections.length - 1].error ? 'failed' : 'complete',
      )
      retain()
      const rest = sections.find((s) => s.key === 'photo_rest')!
      if (
        sections.some((s) => ['rest_usage', 'agent_usage'].includes(s.key) && (s.stale || s.error))
      ) {
        rest.stale = true
        rest.lastSuccessAt = previous?.payload?.sections?.find(
          (s) => s.key === 'photo_rest',
        )?.lastSuccessAt
      }
      const ai = sections.find((s) => s.key === 'ai')!
      // Reuse the same metering snapshot: personal AI must reconcile with All users.
      sections.push({
        key: 'personal_ai',
        label: 'Attributed app AI credits',
        rows: ai.rows.filter((r) => r.WORK_ID),
        error: ai.error,
        stale: ai.stale,
        lastSuccessAt: ai.lastSuccessAt,
      })
      if (ai.rows.some((r) => aiCostPurpose(r) === 'pending_embedding'))
        sections.push({
          key: 'classification',
          label: 'Some embedding costs await Snowflake refresh metadata; totals are partial',
          rows: [],
          error: 'Pending refresh metadata',
        })
      const payload = {
        sections,
        days: 30,
        window: 'Last 30 Eastern days, including today (partial)',
        timeZone: COST_TIME_ZONE,
        asOf: new Date().toISOString(),
      }
      await pgTransaction(async () => {
        progress.status = 'completed'
        progress.updatedAt = new Date().toISOString()
        // Fence before publication. A process that lost ownership cannot overwrite
        // a successor's report. Both status and report commit, or neither does.
        await persistProgress()
        await pgQuery(
          "UPDATE app_reports SET payload=$1::jsonb,refreshed_at=NOW() WHERE name='costs'",
          [JSON.stringify(payload)],
        )
      })
      return payload
    } catch (error) {
      await pgQuery(
        `UPDATE app_reports SET payload=payload || jsonb_build_object(
           'status','failed','error',$2::text,'updatedAt',now())
         WHERE name='costs-progress' AND payload->>'runId'=$1 AND payload->>'status'='running'`,
        [progress.runId, INTERRUPTED],
      ).catch((writeError) => console.error('[cost-report-progress]', writeError))
      throw error
    }
  })
  if (!result) throw new HttpError(409, 'A cost refresh is already running')
  return result
}
async function storedCostReportService(recordSnapshot = true) {
  const storage = await pgQueryOne<{
    active_bytes: string
    trash_bytes: string
    media_count: number
  }>(`SELECT
  (SELECT COALESCE(SUM(file_size_bytes),0) FROM photos) AS active_bytes,
  (SELECT COALESCE(SUM((photo_data->>'file_size_bytes')::bigint),0) FROM photo_trash) AS trash_bytes,
  (SELECT count(*)::int FROM photos) AS media_count`)
  if (recordSnapshot)
    await pgQuery(
      `INSERT INTO storage_snapshots(day,active_bytes,trash_bytes,media_count) VALUES((NOW() AT TIME ZONE 'UTC')::date,$1,$2,$3)
  ON CONFLICT(day) DO UPDATE SET active_bytes=EXCLUDED.active_bytes,trash_bytes=EXCLUDED.trash_bytes,media_count=EXCLUDED.media_count,sampled_at=NOW()`,
      [storage!.active_bytes, storage!.trash_bytes, storage!.media_count],
    )
  return {
    storage,
    snapshots: await pgQuery(
      `SELECT * FROM storage_snapshots WHERE day >= (NOW() AT TIME ZONE 'UTC')::date - 29 ORDER BY day ASC`,
    ),
    report: await pgQueryOne("SELECT payload,refreshed_at FROM app_reports WHERE name='costs'"),
  }
}

export function refreshCostReport(...args: Parameters<typeof refreshCostReportService>) {
  return withServiceDatabase(() => refreshCostReportService(...args))
}

export function storedCostReport(...args: Parameters<typeof storedCostReportService>) {
  return withServiceDatabase(() => storedCostReportService(...args))
}

/** Read completion metadata without decoding the large saved usage report. */
export function costRefreshProgress() {
  return withServiceDatabase(async () => {
    // No warehouse work or timer-based guesses: an occupied lock means a live
    // owner; a free lock permits truthful recovery across replicas and restarts.
    await withAdvisoryLock(REFRESH_LOCK, interruptAbandonedRefresh)
    const row = await pgQueryOne<{
      payload: CostRefreshProgress | null
      as_of: string | null
    }>(`SELECT
      (SELECT payload FROM app_reports WHERE name='costs-progress') AS payload,
      (SELECT refreshed_at FROM app_reports WHERE name='costs') AS as_of`)
    // Keep the existing top-level progress shape for already-open browser tabs.
    return {
      ...(row?.payload ?? { startedAt: '', updatedAt: '', sources: [] }),
      asOf: row?.as_of ?? null,
    }
  })
}
