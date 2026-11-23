import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
}
function positive(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
function configured(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const value = positive(raw)
  if (!value) throw Error(`Invalid ${name}`)
  return value
}
export function parseCpuQuota(quota: string | undefined, period?: string): number | undefined {
  const parts = quota?.split(/\s+/)
  if (!parts) return undefined
  const q = positive(parts[0])
  const p = positive(period ?? parts[1])
  return q && p ? q / p : undefined
}
/** Startup snapshot: changing a Snowflake instance family restarts containers.
 * Configured limits and cgroup limits are ceilings, never host-machine totals. */
export function detectUploadResources() {
  const quota =
    parseCpuQuota(read('/sys/fs/cgroup/cpu.max')) ??
    parseCpuQuota(
      read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
      read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
    )
  const configuredCpu = configured('UPLOAD_RESOURCE_CPU')
  const memory =
    positive(read('/sys/fs/cgroup/memory.max')) ??
    positive(read('/sys/fs/cgroup/memory/memory.limit_in_bytes'))
  const constrained = positive(process.constrainedMemory?.())
  const configuredMemory = configured('UPLOAD_RESOURCE_MEMORY_MIB')
  const memoryBounds = [
    memory && memory / 1048576,
    constrained && constrained / 1048576,
    configuredMemory,
  ].filter((n): n is number => n !== undefined)
  return {
    cpu: Math.min(availableParallelism(), quota ?? Infinity, configuredCpu ?? Infinity),
    // Unknown memory must not turn a large host into an unlimited worker.
    memoryMiB: memoryBounds.length ? Math.min(...memoryBounds) : 5120,
  }
}
export function deriveUploadCapacity(resources: { cpu: number; memoryMiB: number }) {
  if (
    !Number.isFinite(resources.cpu) ||
    resources.cpu <= 0 ||
    !Number.isFinite(resources.memoryMiB) ||
    resources.memoryMiB < 2560
  )
    throw Error('Insufficient or invalid upload worker resources')
  // Reserve at least 1 GiB (20% on larger workers) for runtime/chunk buffering;
  // budget 1.5 GiB per in-flight media job.
  // This is an admission budget, not a guarantee for arbitrary image workloads.
  const reserveMiB = Math.max(1024, resources.memoryMiB * 0.2)
  const completions = Math.max(
    1,
    Math.min(
      10000,
      Math.floor(resources.cpu * 2),
      Math.floor((resources.memoryMiB - reserveMiB) / 1536),
    ),
  )
  const chunks = Math.max(
    1,
    Math.min(10000, Math.floor(resources.cpu * 8), Math.floor((reserveMiB - 512) / 32)),
  )
  return { completions, chunks }
}
let detected: ReturnType<typeof deriveUploadCapacity> | undefined
export function automaticUploadCapacity() {
  return (detected ??= deriveUploadCapacity(detectUploadResources()))
}
