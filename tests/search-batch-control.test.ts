import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const sf = vi.hoisted(() => vi.fn())
vi.mock('@/lib/snowflake', () => ({ querySnowflake: sf }))
import { searchBatchCommand } from '@/lib/search/search-batch-control'

afterEach(() => vi.unstubAllEnvs())
const id = '4308fe31-8245-4fb4-acad-5e6c3dd67e8c'
const name = `SEARCH_BATCH_${id.replaceAll('-', '').toUpperCase()}`
let jobs: Record<string, unknown>[]
let pool: Record<string, unknown>
beforeEach(() => {
  jobs = []
  pool = { name: 'PERSONAL_PHOTOS_SEARCH_CPU', state: 'SUSPENDED', num_jobs: 0, num_services: 0 }
  sf.mockReset().mockImplementation(async (sql: string) => {
    if (sql.startsWith('SHOW JOB SERVICES')) return jobs
    if (sql.startsWith('SHOW COMPUTE POOLS')) return [pool]
    return []
  })
})
it('launches only through warehouse-free metadata/DDL, with the fixed worker specification', async () => {
  expect((await searchBatchCommand(id, 'START')).status).toBe('PENDING')
  const commands = sf.mock.calls.map(([sql]) => sql as string)
  expect(
    commands.some((sql) => sql.startsWith('ALTER COMPUTE POOL PERSONAL_PHOTOS_SEARCH_CPU RESUME')),
  ).toBe(true)
  const launch = commands.find((sql) => sql.startsWith('EXECUTE JOB SERVICE'))!
  expect(launch).toContain(`NAME=PERSONAL_MEDIA.APP.${name}`)
  expect(launch).toContain(`"WORKER_RUN_ID":"${id}"`)
  expect(
    commands.every((sql) => /^(SHOW |ALTER COMPUTE POOL |EXECUTE JOB SERVICE )/.test(sql)),
  ).toBe(true)
  expect(commands.some((sql) => /^(CALL|SELECT|USE WAREHOUSE)/.test(sql))).toBe(false)
})
it('reuses an existing run without starting another job', async () => {
  jobs = [{ name, status: 'RUNNING' }]
  await searchBatchCommand(id, 'START')
  expect(sf.mock.calls.every(([sql]) => sql.startsWith('SHOW '))).toBe(true)
})
it('uses SHOW for status and does not touch running compute', async () => {
  jobs = [{ name, status: 'RUNNING' }]
  expect((await searchBatchCommand(id, 'STATUS')).status).toBe('RUNNING')
  expect(sf.mock.calls.every(([sql]) => sql.startsWith('SHOW '))).toBe(true)
})
it('never suspends a pool with another active job', async () => {
  jobs = [{ name, status: 'DONE' }]
  pool.state = 'ACTIVE'
  pool.num_jobs = 1
  await searchBatchCommand(id, 'SETTLE')
  expect(sf.mock.calls.every(([sql]) => sql.startsWith('SHOW '))).toBe(true)
})
it('suspends idle compute after a completed job', async () => {
  jobs = [{ name, status: 'DONE' }]
  pool.state = 'ACTIVE'
  await searchBatchCommand(id, 'SETTLE')
  expect(sf).toHaveBeenCalledWith('ALTER COMPUTE POOL PERSONAL_PHOTOS_SEARCH_CPU SUSPEND')
})
it('rejects malformed identifiers before issuing SQL', async () => {
  await expect(searchBatchCommand("'; DROP SERVICE x", 'START')).rejects.toThrow('Invalid run ID')
  expect(sf).not.toHaveBeenCalled()
})
it('cancels only the selected job and preserves other running jobs', async () => {
  jobs = [{ name, status: 'RUNNING' }]
  pool.state = 'ACTIVE'
  pool.num_jobs = 2
  expect((await searchBatchCommand(id, 'CANCEL')).status).toBe('CANCELLED')
  expect(sf).toHaveBeenCalledWith(`DROP SERVICE IF EXISTS PERSONAL_MEDIA.APP.${name}`)
  expect(sf.mock.calls.some(([sql]) => sql.startsWith('ALTER COMPUTE POOL'))).toBe(false)
})

it('settles a pre-migration job on its original pool without touching the new pool', async () => {
  jobs = [{ name, status: 'DONE', compute_pool: 'PERSONAL_PHOTOS_FACE_CPU' }]
  pool = { name: 'PERSONAL_PHOTOS_FACE_CPU', state: 'ACTIVE', num_jobs: 0, num_services: 0 }
  await searchBatchCommand(id, 'SETTLE')
  expect(sf).toHaveBeenCalledWith('ALTER COMPUTE POOL PERSONAL_PHOTOS_FACE_CPU SUSPEND')
  expect(sf.mock.calls.some(([sql]) => sql.includes('PERSONAL_PHOTOS_SEARCH_CPU'))).toBe(false)
})

it('passes only validated map-summary settings to the admin-started worker', async () => {
  vi.stubEnv('TRAVEL_SUMMARIES_ENABLED', 'true')
  vi.stubEnv('TRAVEL_SUMMARY_MAX_ALBUMS', '25')
  await searchBatchCommand(id, 'START')
  const launch = sf.mock.calls
    .map(([sql]) => sql as string)
    .find((sql) => sql.startsWith('EXECUTE JOB SERVICE'))!
  expect(launch).toContain('"TRAVEL_SUMMARIES_ENABLED":"true"')
  expect(launch).toContain('"TRAVEL_SUMMARY_MAX_ALBUMS":"25"')
})
it('rejects invalid summary limits before resuming compute', async () => {
  vi.stubEnv('TRAVEL_SUMMARIES_ENABLED', 'true')
  vi.stubEnv('TRAVEL_SUMMARY_MAX_ALBUMS', '1001')
  await expect(searchBatchCommand(id, 'START')).rejects.toThrow('Invalid TRAVEL_SUMMARY_MAX_ALBUMS')
  expect(sf.mock.calls.every(([sql]) => sql.startsWith('SHOW '))).toBe(true)
})

it('caps worker processing and the hard timeout to the remaining update time', async () => {
  await searchBatchCommand(id, 'START', Date.now() + 180000)
  const launch = sf.mock.calls
    .map(([s]) => s as string)
    .find((s) => s.startsWith('EXECUTE JOB SERVICE'))!
  const spec = JSON.parse(
    launch
      .split("FROM SPECIFICATION '")[1]
      .slice(0, -1)
      .replaceAll("''", "'")
      .replace(/\\(.)/g, '$1'),
  )
  const worker = spec.spec.containers[0]
  expect(Number(worker.env.SEARCH_UPDATE_DEADLINE)).toBeLessThanOrEqual(
    Math.floor(Date.now() / 1000) + 180,
  )
  expect(worker.command).toEqual(['/bin/sh'])
  expect(worker.args[0]).toBe('-c')
  expect(worker.args[1]).toContain('SEARCH_UPDATE_DEADLINE - $(date +%s)')
  expect(worker.args[1]).toContain('--kill-after=5s')
  expect(worker.args[1]).toContain('"$remaining"')
})
it('does not submit a worker after the update deadline', async () => {
  await expect(searchBatchCommand(id, 'START', Date.now() - 1)).rejects.toThrow('time limit')
  expect(sf.mock.calls.some(([s]) => s.startsWith('EXECUTE JOB SERVICE'))).toBe(false)
})
