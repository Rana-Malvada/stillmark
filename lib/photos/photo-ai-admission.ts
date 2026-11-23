/** Declarative rollout switch. Both modes retain the same coordinator lock. */
export function photoAiAdmission() {
  if (process.env.PHOTO_AI_LEASED_ADMISSION !== 'true') return null
  function value(name: string, max: number, fallback?: number) {
    const n = Number(process.env[name] ?? fallback)
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error(`Invalid ${name}`)
    return n
  }
  const fleet = value('PHOTO_AI_FLEET_CONCURRENCY', 1000, 3)
  const tenant = value('PHOTO_AI_TENANT_CONCURRENCY', fleet, 1)
  // Explicit budgets are required: enabling parallel schedulers must not silently
  // multiply paid requests. Retries and same-file reuse also consume this allowance.
  const hourly = value('PHOTO_AI_MAX_CLAIMS_PER_HOUR', 1000000)
  const tenantHourly = value('PHOTO_AI_TENANT_MAX_CLAIMS_PER_HOUR', hourly)
  const workers = value('PHOTO_AI_LOCAL_WORKERS', fleet, Math.min(3, fleet))
  if (process.env.PHOTO_AI_TRANSPORT !== 'rest')
    throw Error('Leased photo AI admission requires direct REST transport')
  return { fleet, tenant, hourly, tenantHourly, workers }
}
