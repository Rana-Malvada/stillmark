import { afterEach, expect, it, vi } from 'vitest'
import { deriveUploadCapacity, parseCpuQuota } from '../lib/upload/upload-resource-capacity'
import { uploadNodeProfiles, uploadWorkerResources } from '../workers/upload-cpu/resources.mjs'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})
it('scales processing with CPUs while respecting the memory budget', () => {
  expect(deriveUploadCapacity({ cpu: 1, memoryMiB: 5120 })).toEqual({ completions: 2, chunks: 8 })
  expect(deriveUploadCapacity({ cpu: 6, memoryMiB: 26624 }).completions).toBe(12)
  expect(deriveUploadCapacity({ cpu: 28, memoryMiB: 116736 }).completions).toBe(56)
  expect(deriveUploadCapacity({ cpu: 28, memoryMiB: 5120 }).completions).toBe(2)
  expect(deriveUploadCapacity({ cpu: 0.5, memoryMiB: 5120 }).completions).toBe(1)
  for (const family of Object.keys(uploadNodeProfiles)) {
    const r = uploadWorkerResources(family)
    const memoryMiB = Number(r.limits.memory.replace('Gi', '')) * 1024
    const capacity = deriveUploadCapacity({ cpu: r.limits.cpu, memoryMiB })
    expect(capacity.completions * 1536 + capacity.chunks * 32 + 512).toBeLessThanOrEqual(memoryMiB)
  }
})
it('uses cgroup quotas including fractional CPUs and unlimited values', () => {
  expect(parseCpuQuota('150000 100000')).toBe(1.5)
  expect(parseCpuQuota('200000', '100000')).toBe(2)
  expect(parseCpuQuota('max 100000')).toBeUndefined()
  expect(parseCpuQuota('-1', '100000')).toBeUndefined()
  expect(parseCpuQuota('100000 0')).toBeUndefined()
})
it('rejects invalid resources and unverified instance families', () => {
  for (const cpu of [NaN, Infinity, 0, -1])
    expect(() => deriveUploadCapacity({ cpu, memoryMiB: 5120 })).toThrow()
  expect(() => deriveUploadCapacity({ cpu: 1, memoryMiB: 1024 })).toThrow()
  expect(() => uploadWorkerResources('CPU_X64_UNKNOWN')).toThrow()
  expect(uploadWorkerResources('CPU_X64_XS')).toEqual({
    requests: { cpu: 1, memory: '4Gi' },
    limits: { cpu: 1, memory: '5Gi' },
  })
})
it('honors configured container ceilings and rejects invalid configured resources', async () => {
  vi.stubEnv('UPLOAD_RESOURCE_CPU', '0.5')
  vi.stubEnv('UPLOAD_RESOURCE_MEMORY_MIB', '3072')
  const { detectUploadResources } = await import('../lib/upload/upload-resource-capacity')
  expect(detectUploadResources().cpu).toBeLessThanOrEqual(0.5)
  expect(detectUploadResources().memoryMiB).toBeLessThanOrEqual(3072)
  vi.stubEnv('UPLOAD_RESOURCE_CPU', 'typo')
  expect(detectUploadResources).toThrow('Invalid UPLOAD_RESOURCE_CPU')
})
it('uses one capacity calculation for queue slots and HTTP admission with manual overrides retained', async () => {
  vi.stubEnv('UPLOAD_COMPLETIONS_PER_INSTANCE', 'auto')
  vi.stubEnv('UPLOAD_CHUNKS_PER_INSTANCE', 'auto')
  vi.stubEnv('UPLOAD_RESOURCE_CPU', '1')
  vi.stubEnv('UPLOAD_RESOURCE_MEMORY_MIB', '5120')
  const m = await import('../lib/upload/upload-capacity')
  expect(m.uploadCompletionLimit()).toBe(2)
  expect(m.uploadChunkLimit()).toBe(8)
  vi.stubEnv('UPLOAD_COMPLETIONS_PER_INSTANCE', '4')
  expect(m.uploadCompletionLimit()).toBe(4)
})
