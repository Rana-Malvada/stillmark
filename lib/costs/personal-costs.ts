import { COST_POOLS, productionPoolSection } from './cost-pools'
import { productionCostEstimates } from '../production-cost-estimates'
import { COST_TIME_ZONE, costDay, costMidnight } from './cost-timezone'
import { withServiceDatabase } from '../database/database-context'
import { type AiCostKind, aiCostPurpose } from '../ai-cost-purpose'
import { pgQuery, pgQueryOne } from '../postgres'
import { HttpError } from '../http'
import type { AlbumCaller } from '../albums/album-access'

export interface CostSection {
  key: string
  label: string
  rows: Record<string, unknown>[]
  error: string | null
  stale?: boolean
  lastSuccessAt?: string
}
export interface CostWorkRow {
  id: string
  category: string
  owners: Record<string, number>
}
const value = (r: Record<string, unknown>, k: string) => r[k] ?? r[k.toLowerCase()]
const num = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN)
export function sumCredits(section: CostSection | undefined, key = 'CREDITS'): number | null {
  if (!section || section.error) return null
  let total = 0
  for (const r of section.rows) {
    const n = num(value(r, key))
    if (!Number.isFinite(n)) return null
    total += n
  }
  return total
}
export function share(weights: Record<string, number>, username: string): number {
  const total = Object.values(weights).reduce(
    (a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0),
    0,
  )
  return total > 0 ? Math.max(0, weights[username] ?? 0) / total : 0
}
export function costScope(caller: AlbumCaller, requested: string | null) {
  const canAll = caller.mainAdmin || caller.role === 'admin_readonly' || caller.role === 'admin'
  const selected = requested ?? (canAll ? 'all' : caller.username)
  if (selected === 'all') {
    if (!canAll) throw new HttpError(403, 'Your own costs only')
    return { selected, canAll, canFilter: caller.mainAdmin }
  }
  if (selected !== caller.username && !caller.mainAdmin)
    throw new HttpError(403, 'Your own costs only')
  return { selected, canAll, canFilter: caller.mainAdmin }
}
export function attributedCredits(
  section: CostSection | undefined,
  works: CostWorkRow[],
  username: string,
) {
  if (!section || section.error) return null
  const byId = new Map(works.map((w) => [w.id, w]))
  let total = 0
  for (const r of section.rows) {
    const work = byId.get(String(value(r, 'WORK_ID')))
    if (!work || share(work.owners, username) === 0) continue
    const n = num(value(r, 'CREDITS'))
    if (!Number.isFinite(n)) return null
    total += n * share(work.owners, username)
  }
  return total
}
export function aiSection(
  section: CostSection | undefined,
  kind: AiCostKind,
  works: CostWorkRow[] = [],
): CostSection | undefined {
  if (!section) return undefined
  const byId = new Map(works.map((w) => [w.id, w]))
  return {
    ...section,
    rows: section.rows.filter(
      (r) => aiCostPurpose(r, byId.get(String(value(r, 'WORK_ID')))?.category) === kind,
    ),
  }
}
/** Preserve known charges when other requests are still awaiting billing. */
export function knownRestCosts(section: CostSection | undefined): CostSection | undefined {
  if (!section || section.error) return section
  const rows = section.rows.filter((r) => {
    const credits = value(r, 'CREDITS')
    return credits != null && Number.isFinite(num(credits))
  })
  if (section.rows.length && !rows.length) return undefined
  return { ...section, rows }
}
export interface CostMember {
  username: string
  joined_at?: string | null
  deleted_at?: string | null
}
/** Allocate a daily shared charge by membership-seconds, never before joining.
 * Daily metering cannot establish exact intraday consumption; this is an estimate. */
export function membershipShare(
  members: CostMember[],
  username: string,
  day: string,
  timeZone: string,
  asOf: string,
) {
  const start = costMidnight(day, timeZone)
  const next = new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  const end = Math.min(costMidnight(next, timeZone), Date.parse(asOf))
  const weights: Record<string, number> = {}
  for (const member of members) {
    const joined = member.joined_at ? Date.parse(member.joined_at) : NaN
    const deleted = member.deleted_at ? Date.parse(member.deleted_at) : Infinity
    weights[member.username] = Number.isFinite(joined)
      ? Math.max(0, Math.min(end, deleted) - Math.max(start, joined))
      : 0
  }
  return share(weights, username)
}
export const PRICE = { creditUsd: 2, storageTbMonthUsd: 23 }
async function personalCostsService(caller: AlbumCaller, requested: string | null) {
  const scope = costScope(caller, requested)
  const all = scope.selected === 'all'
  const username = scope.selected
  const roster = await pgQuery<{
    username: string
    display_name?: string | null
    email?: string | null
    joined_at?: string | null
    deleted_at?: string | null
  }>(
    `SELECT name AS username,display_name,email,created_at::text AS joined_at,NULL::text AS deleted_at
     FROM gallery_access_objects
     WHERE kind='user' AND state='ready' AND NOT deleting
     UNION ALL
     SELECT name AS username,display_name,email,joined_at::text,deleted_at::text
     FROM deleted_accounts
     ORDER BY username`,
  )
  const users = roster.map((r) => r.username)
  const labelFor = (id: string) => {
    if (id === 'all') return 'All users'
    const profile = roster.find((r) => r.username === id)
    const name = profile?.display_name?.trim()
    return name && !/^U_[a-f0-9]+$/i.test(name)
      ? name
      : profile?.email || (/^U_[a-f0-9]+$/i.test(id) ? 'Member' : id)
  }
  const historical = scope.canFilter
    ? await pgQuery<{ username: string }>(
        'SELECT DISTINCT jsonb_object_keys(owners) AS username FROM cost_work UNION SELECT DISTINCT owner_username FROM events ORDER BY username',
      )
    : []
  if (
    !all &&
    !users.includes(username) &&
    username !== caller.username &&
    !historical.some((r) => r.username === username)
  )
    throw new HttpError(404, 'User not found')
  const cached = await pgQueryOne<{
    payload: { sections?: CostSection[]; asOf?: string; timeZone?: string }
    refreshed_at: string | null
  }>("SELECT payload,refreshed_at FROM app_reports WHERE name='costs'")
  // Do not expand/re-aggregate the large report in Postgres on every page read.
  // Diagnostic account sections are needed for reconciliation, not personal totals.
  const timeZoneForEstimates = cached?.payload.timeZone === COST_TIME_ZONE ? COST_TIME_ZONE : 'UTC'
  const sections = [
    ...(cached?.payload.sections ?? []).filter(
      (s) => !['runtime', 'postgres', 'rest_usage', 'agent_usage', 'activity'].includes(s.key),
    ),
    ...productionCostEstimates(cached?.payload.asOf, timeZoneForEstimates),
  ]
  const section = (key: string) => {
    const source = sections.find((s) => s.key === key)
    return COST_POOLS.some((pool) => pool.key === key) ? productionPoolSection(source, key) : source
  }
  const timeZone = cached?.payload.timeZone === COST_TIME_ZONE ? COST_TIME_ZONE : 'UTC'
  const timezoneRefreshNeeded = timeZone !== COST_TIME_ZONE
  const end = costDay(cached?.payload.asOf ?? new Date().toISOString(), timeZone)
  const works = await pgQuery<CostWorkRow>(
    `SELECT id,category,owners FROM cost_work WHERE ($2::boolean OR owners ? $3::text) AND created_at>=($1::date-30)::timestamp AT TIME ZONE '${timeZone}'`,
    [end, all, username],
  )
  const workById = new Map(works.map((work) => [work.id, work]))
  const started = await pgQueryOne<{ started: string }>(
    'SELECT min(created_at)::text AS started FROM cost_work',
  )
  const storage = await pgQueryOne<{ bytes: string; files: number }>(
    `SELECT COALESCE(sum(bytes),0)::text AS bytes,COALESCE(sum(files),0)::int AS files FROM (
 SELECT COALESCE(sum(p.file_size_bytes),0) AS bytes,count(*) AS files FROM photos p JOIN events e USING(event_id) WHERE ($1 OR e.owner_username=$2)
 UNION ALL SELECT COALESCE(sum((photo_data->>'file_size_bytes')::bigint),0),0 FROM photo_trash WHERE ($1 OR owner_username=$2)) s`,
    [all, username],
  )
  const transfers = await pgQueryOne<{ uploads: string; downloads: string }>(
    `SELECT COALESCE(sum((details->>'bytes')::numeric) FILTER(WHERE kind='upload_completed' AND details->>'outcome'='success'),0)::text AS uploads,
 COALESCE(sum((details->>'bytes')::numeric) FILTER(WHERE kind='download_requested'),0)::text AS downloads FROM user_activity_events
 WHERE source='server' AND occurred_at>=(date_trunc('day',now() AT TIME ZONE '${timeZone}')-interval '29 days') AT TIME ZONE '${timeZone}' AND ($1 OR username=$2)`,
    [all, username],
  )
  const indexWeights = await pgQuery<{
    day: string
    service: string
    username: string
    units: string
  }>(
    `SELECT to_char(w.created_at AT TIME ZONE '${timeZone}','YYYY-MM-DD') AS day,i.service,i.username,sum(i.units)::text AS units
 FROM cost_index_weights i JOIN cost_work w ON w.id=i.work_id WHERE i.phase='refresh' AND w.created_at>=($1::date-30)::timestamp AT TIME ZONE '${timeZone}' GROUP BY 1,2,3`,
    [end],
  )
  const embedding = (s: CostSection | undefined) => {
    if (!s || s.error) return null
    let total = 0
    let matched = false
    for (const r of s.rows) {
      const weights = Object.fromEntries(
        indexWeights
          .filter(
            (w) =>
              w.day === String(value(r, 'DAY')) && w.service === String(value(r, 'SERVICE_NAME')),
          )
          .map((w) => [w.username, Number(w.units)]),
      )
      if (Object.keys(weights).length) {
        matched = true
        const n = num(value(r, 'CREDITS'))
        if (!Number.isFinite(n)) return null
        total += n * share(weights, username)
      }
    }
    return matched ? total : null
  }
  // Only ledger-matched app work belongs in app totals; account-wide/test usage is excluded.
  const productionWork = (source: CostSection | undefined) => {
    if (!source) return undefined
    const rows = source.rows.filter((r) => workById.has(String(value(r, 'WORK_ID'))))
    // An old aggregate cannot prove zero production usage.
    return source.rows.length && !rows.length ? undefined : { ...source, rows }
  }
  const shared = (source: CostSection | undefined) => {
    if (!source || source.error) return null
    if (all) return sumCredits(source)
    let total = 0
    for (const row of source.rows) {
      const credits = num(value(row, 'CREDITS'))
      const day = String(value(row, 'DAY')).slice(0, 10)
      if (!Number.isFinite(credits) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
      total +=
        credits *
        membershipShare(
          roster,
          username,
          day,
          timeZone,
          cached?.payload.asOf ?? new Date().toISOString(),
        )
    }
    return total
  }
  const aiCost = (kind: AiCostKind, source = section('personal_ai')) =>
    all
      ? sumCredits(aiSection(productionWork(source), kind, works))
      : attributedCredits(aiSection(source, kind, works), works, username)
  const restSection = (source: CostSection | undefined, search: boolean) =>
    source && {
      ...source,
      rows: source.rows.filter(
        (r) =>
          (String(
            value(r, 'PURPOSE') ??
              workById.get(String(value(r, 'WORK_ID')))?.category ??
              'photo_ai',
          ) ===
            'search_ai') ===
          search,
      ),
    }
  const restCost = (source: CostSection | undefined) => {
    const scoped =
      source && !all
        ? {
            ...source,
            rows: source.rows.filter(
              (r) => share(workById.get(String(value(r, 'WORK_ID')))?.owners ?? {}, username) > 0,
            ),
          }
        : productionWork(source)
    const known = knownRestCosts(scoped)
    return all ? sumCredits(known) : attributedCredits(known, works, username)
  }
  const photoCost = (rest: CostSection | undefined, legacy: CostSection | undefined) => {
    const current = restCost(restSection(rest, false))
    const historical = aiCost('photo_ai', legacy)
    return current === null && historical === null ? null : (current ?? 0) + (historical ?? 0)
  }
  // Dollars, not credits: OpenAI bills these directly. Rejected requests carry no
  // amount and cost nothing, so only requests with a recorded estimate are counted.
  const openAiUsd = (source: CostSection | undefined) => {
    if (!source || source.error) return null
    let total = 0
    for (const r of source.rows) {
      const usd = value(r, 'USD')
      const work = workById.get(String(value(r, 'WORK_ID')))
      if (usd == null || !Number.isFinite(num(usd)) || !work) continue
      total += num(usd) * (all ? 1 : share(work.owners, username))
    }
    return total
  }
  const wh = all
    ? sumCredits(productionWork(section('personal_warehouse')))
    : attributedCredits(section('personal_warehouse'), works, username)
  const indexing = all
    ? sumCredits(section('search_indexing'))
    : embedding(section('search_indexing'))

  const services = [
    ...COST_POOLS.map(({ key, label }) => ({
      key,
      label,
      credits: shared(productionPoolSection(section(key), key)),
      method:
        'Metered credits for the dedicated production compute pools, including startup and idle time. Shared equally by membership time within each reported day; no allocation before joining. Per-user amounts are estimates. Snowflake reporting may lag.',
    })),
    {
      key: 'warehouse',
      label: 'Warehouse compute',
      credits: wh,
      method: all
        ? 'Production-ledger-matched queries only. Unmatched and idle warehouse costs are excluded.'
        : 'Tagged app queries only, including AI and search sync. Idle time, untagged work and very short queries are excluded.',
    },
    {
      key: 'cloud_services',
      label: 'App cloud services',
      credits: all ? sumCredits(productionWork(section('cloud_services'))) : null,
      method: all
        ? 'Production-ledger-matched cloud-services queries only, before billing adjustments. Unmatched account usage and legacy aggregate reports are excluded. Refresh usage to obtain request-level attribution.'
        : 'Shared app cloud-services usage is shown under All users. Per-user attribution is unavailable.',
    },
    ...(['video_ai', 'search_ai', 'other_ai'] as const).map((key) => ({
      key,
      label: {
        video_ai: 'Video AI',
        search_ai: 'Search AI — standalone SQL embeddings',
        other_ai: 'Unattributed AI',
      }[key],
      credits: aiCost(key),
      method:
        key === 'other_ai'
          ? 'AI work without a recognized task tag or saved historical classification. Identified photo, video and search processing are excluded.'
          : key === 'search_ai'
            ? 'Standalone SQL embedding function calls outside the photo and album search indexes. Index-building embeddings are counted only under Search AI — add to search.'
            : all
              ? 'Production-ledger-matched photo or video processing. Account-wide and unmatched historical queries are excluded.'
              : 'Actual processing attributed to the album owner when the task starts. Classification follows the task, even if its AI model changes.',
    })),
    {
      key: 'photo_rest',
      label: 'Photo AI',
      credits: photoCost(section('photo_rest'), section('personal_ai')),
      method:
        'Includes recorded photo-description attempts, including retries. Search interpretation is counted separately. Agents charges use Snowflake metered token credits matched by request ID. Direct REST uses metered credits when available, otherwise published token rates. Pending charges are excluded; known charges remain included. Includes historical SQL photo-description charges within the reporting period, counted once; new descriptions use direct REST.',
    },
    {
      key: 'search_rest',
      label: 'Search AI — query interpretation',
      credits: restCost(restSection(section('photo_rest'), true)),
      method:
        'Haiku interpretation of complex searches, attributed to the person who searches. Basic searches skip this call. Includes retries; pending charges are excluded until Snowflake reports billed usage. Separate from photo descriptions, embeddings and search availability.',
    },
    {
      key: 'search_indexing',
      label: 'Search AI — add to search',
      credits: indexing,
      method:
        'Index-building embeddings counted once from the search usage report, excluded from all other AI rows. Snowflake daily embedding buckets are dated by their start in the report timezone; exact intraday embedding timing is unavailable. Daily credits allocated by submitted content size and album owner. Estimated; older work and days without ownership records are unallocated. Sync warehouse compute is included above.',
    },
    {
      key: 'search',
      label: 'Search availability',
      credits: shared(section('search')),
      method:
        'Production search services only. Shared availability is estimated by membership time within each reported day, including partial signup days; no costs before joining. Daily metering cannot establish exact intraday consumption.',
    },
    {
      key: 'postgres',
      label: 'PostgreSQL compute — estimated',
      credits: shared(section('postgres')),
      method:
        'Production database only: estimated BURST_S running hours at 0.0136 credits/hour. Split equally by membership time each day, including partial days. No allocation before signup or after account deletion. Storage is separate.',
    },
    {
      key: 'runtime',
      label: 'App hosting — estimated',
      credits: shared(section('runtime')),
      method:
        'Production app only: one continuously running instance estimated at 0.0297 credits/hour using the single-app baseline. Shared equally by membership time each day, including partial days. This is a hosting estimate, not an attributed Snowflake invoice.',
    },
  ]
    .filter((s) => s.key !== 'search_ai' || s.credits !== 0)
    .map((s) => ({ ...s, usd: s.credits === null ? null : s.credits * PRICE.creditUsd }))
  // Listed only once OpenAI has described something in the period.
  const openAiTotal = openAiUsd(section('photo_openai'))
  if (openAiTotal)
    services.push({
      key: 'photo_openai',
      label: 'Photo AI — OpenAI (direct)',
      credits: null,
      method:
        'Photo descriptions sent to OpenAI directly instead of Snowflake Cortex. Billed by OpenAI in dollars, not Snowflake credits. Estimated from the tokens each response reports at OpenAI list prices; any plan credit is not deducted. Attributed to the album owner.',
      usd: openAiTotal,
    })
  const dailySections = [
    ...COST_POOLS.map(({ key }) => key),
    'warehouse',
    'cloud_services',
    'photo_rest',
    'search_rest',
    'video_ai',
    'search_ai',
    'other_ai',
    'search_indexing',
    'search',
    'postgres',
    'runtime',
  ]

  const daily = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(Date.parse(end + 'T00:00:00Z') - (29 - i) * 86400000)
      .toISOString()
      .slice(0, 10)
    const dailySource = (key: string) => {
      const s = section(key)
      return s
        ? { ...s, rows: s.rows.filter((r) => String(value(r, 'DAY')).slice(0, 10) === day) }
        : undefined
    }
    const credits = dailySections.map((key) => {
      if (key === 'video_ai' || key === 'search_ai' || key === 'other_ai')
        return aiCost(key, dailySource('personal_ai'))
      if (key === 'photo_rest')
        return photoCost(dailySource('photo_rest'), dailySource('personal_ai'))
      if (key === 'search_rest') {
        return restCost(restSection(dailySource('photo_rest'), key === 'search_rest'))
      }
      if (COST_POOLS.some((pool) => pool.key === key))
        return shared(productionPoolSection(dailySource(key), key))
      if (['search', 'postgres', 'runtime'].includes(key)) return shared(dailySource(key))
      if (all && key === 'search_indexing') return sumCredits(dailySource(key))
      if (all)
        return sumCredits(
          productionWork(dailySource(key === 'warehouse' ? 'personal_warehouse' : key)),
        )
      if (['gpu', 'faces', 'cloud_services', 'postgres', 'runtime'].includes(key)) return null
      if (key === 'warehouse' || key === 'ai')
        return attributedCredits(dailySource('personal_' + key), works, username)
      if (key === 'search_indexing') return embedding(dailySource(key))
      return null
    })
    const openAi = openAiTotal ? (openAiUsd(dailySource('photo_openai')) ?? 0) : 0
    return {
      day,
      ...Object.fromEntries(
        dailySections.map((key, index) => [
          key,
          credits[index] === null ? null : credits[index]! * PRICE.creditUsd,
        ]),
      ),
      ...(openAiTotal ? { photo_openai: openAi } : {}),
      usd:
        credits.every((c) => c === null) && !openAi
          ? null
          : credits.reduce<number>((a, b) => a + (b ?? 0), 0) * PRICE.creditUsd + openAi,
    }
  })
  return {
    ...scope,
    selectedLabel: labelFor(scope.selected),
    userLabels: scope.canFilter
      ? Object.fromEntries(
          [...users, ...historical.map((r) => r.username)].map((id) => [id, labelFor(id)]),
        )
      : {},
    timeZone,
    timezoneRefreshNeeded,
    periodEnd: end,
    users: scope.canFilter
      ? [...new Set([...users, ...historical.map((r) => r.username)])].sort()
      : [],
    services,
    daily,
    subtotalUsd: services.every((s) => s.usd === null)
      ? null
      : services.reduce((a, s) => a + (s.usd ?? 0), 0),
    asOf: cached?.refreshed_at ?? null,
    trackingStarted: started?.started ?? null,
    prices: PRICE,
    storage: {
      bytes: Number(storage?.bytes ?? 0),
      files: storage?.files ?? 0,
      monthlyUsd: (Number(storage?.bytes ?? 0) / 1e12) * PRICE.storageTbMonthUsd,
    },
    transfers: {
      uploadedBytes: Number(transfers?.uploads ?? 0),
      requestedDownloadBytes: Number(transfers?.downloads ?? 0),
    },
    canRefresh: caller.role === 'admin',
    restUsageMissing:
      !section('photo_rest') ||
      !!section('photo_rest')?.error ||
      (section('photo_rest')?.rows.some(
        (r) =>
          (all || share(workById.get(String(value(r, 'WORK_ID')))?.owners ?? {}, username) > 0) &&
          value(r, 'CREDITS') == null,
      ) ??
        false),
    staleSources: sections
      .filter((s) => s.stale)
      .map((s) => ({ label: s.label, lastSuccessAt: s.lastSuccessAt })),
    errors: sections
      .filter(
        (s) =>
          s.error &&
          [
            'gpu',
            'faces',
            'uploads',
            'warehouse',
            'cloud_services',
            'ai',
            'search',
            'search_indexing',
            'postgres',
            'runtime',
            'personal_ai',
            'personal_warehouse',
            'classification',
            'photo_rest',
          ].includes(s.key),
      )
      .map((s) => s.label),
  }
}

export function personalCosts(...args: Parameters<typeof personalCostsService>) {
  return withServiceDatabase(() => personalCostsService(...args))
}
