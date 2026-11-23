import { restCredits } from './cortex-rest-costs'

type Row = Record<string, unknown>
function object(value: unknown): Row {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}
}
/** Normalize Snowflake's account usage records without inventing missing charges. */
export function recordedRestUsage(row: Row): Row {
  const record = object(row.USAGE_RECORD)
  const tokens = object(row.TOKENS_GRANULAR)
  const billed = record.CREDITS
  const metered =
    (typeof billed === 'number' || typeof billed === 'string') &&
    billed !== '' &&
    Number.isFinite(Number(billed)) &&
    Number(billed) >= 0
  const knownKeys = ['input', 'output', 'cache_read_input', 'cache_creation_input']
  const unknownTokens = Object.entries(tokens).some(
    ([key, value]) => !knownKeys.includes(key) && Number(value) !== 0,
  )
  const credits = metered
    ? Number(billed)
    : unknownTokens
      ? null
      : restCredits(String(row.MODEL_NAME), {
          input_tokens: tokens.input,
          output_tokens: tokens.output,
          cache_read_input_tokens: tokens.cache_read_input,
          cache_creation_input_tokens: tokens.cache_creation_input,
        })
  return {
    DAY: row.DAY,
    REQUEST_ID: row.REQUEST_ID,
    MODEL_NAME: row.MODEL_NAME,
    TOKENS: row.TOKENS,
    CREDITS: credits,
    BASIS: metered ? 'Snowflake metered credits' : 'Snowflake tokens × published rate',
  }
}
export function reconcileRestUsage(local: Row[], recorded: Row[], agents: Row[] = []): Row[] {
  const byId = new Map(recorded.map((row) => [String(row.REQUEST_ID), row]))
  const agentsById = new Map(agents.map((row) => [String(row.REQUEST_ID), row]))
  return local.map((row) => {
    const source = row.PRICING_VERSION === 'agents-unverified' ? agentsById : byId
    const match = row.PROVIDER_REQUEST_ID ? source.get(String(row.PROVIDER_REQUEST_ID)) : undefined
    return {
      ...row,
      CREDITS: match ? match.CREDITS : row.CREDITS,
      BASIS: match
        ? match.BASIS
        : row.PRICING_VERSION === 'agents-unverified'
          ? 'Agents credits unavailable; tokens recorded'
          : 'Response tokens × published rate',
      RECONCILED: Boolean(match),
    }
  })
}
