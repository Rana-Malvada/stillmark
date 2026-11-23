import type { personalCosts } from './personal-costs'

export type PersonalCostData = Awaited<ReturnType<typeof personalCosts>>
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const numeric = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const nullableNumeric = (v: unknown) => v === null || numeric(v)
const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string')

/** Report rendering must retain missing costs as unavailable, never coerce them to zero. */
export function isPersonalCostData(value: unknown): value is PersonalCostData {
  if (!record(value)) return false
  return (
    ['selected', 'selectedLabel', 'timeZone', 'periodEnd'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    ['canFilter', 'canRefresh'].every((key) => typeof value[key] === 'boolean') &&
    ['timezoneRefreshNeeded', 'restUsageMissing'].every(
      (key) => value[key] === undefined || typeof value[key] === 'boolean',
    ) &&
    ['asOf', 'trackingStarted'].every(
      (key) => value[key] === null || typeof value[key] === 'string',
    ) &&
    strings(value.users) &&
    strings(value.errors) &&
    record(value.userLabels) &&
    Object.values(value.userLabels).every((label) => typeof label === 'string') &&
    nullableNumeric(value.subtotalUsd) &&
    record(value.prices) &&
    numeric(value.prices.creditUsd) &&
    record(value.storage) &&
    numeric(value.storage.bytes) &&
    numeric(value.storage.monthlyUsd) &&
    (numeric(value.storage.files) ||
      (typeof value.storage.files === 'string' && /^\d+$/.test(value.storage.files))) &&
    record(value.transfers) &&
    numeric(value.transfers.uploadedBytes) &&
    numeric(value.transfers.requestedDownloadBytes) &&
    Array.isArray(value.services) &&
    value.services.every(
      (s) =>
        record(s) &&
        ['key', 'label', 'method'].every((key) => typeof s[key] === 'string') &&
        nullableNumeric(s.credits) &&
        nullableNumeric(s.usd),
    ) &&
    Array.isArray(value.daily) &&
    value.daily.every(
      (row) =>
        record(row) &&
        typeof row.day === 'string' &&
        Object.entries(row).every(([key, v]) => key === 'day' || nullableNumeric(v)),
    ) &&
    Array.isArray(value.staleSources) &&
    value.staleSources.every(
      (s) =>
        record(s) &&
        typeof s.label === 'string' &&
        (s.lastSuccessAt === undefined || typeof s.lastSuccessAt === 'string'),
    )
  )
}
