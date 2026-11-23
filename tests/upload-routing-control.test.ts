import { beforeEach, expect, it, vi } from 'vitest'

const sf = vi.hoisted(() => vi.fn())
vi.mock('@/lib/snowflake', () => ({ querySnowflake: sf }))
import { uploadPoolStep } from '@/lib/upload/upload-routing-control'

let pool: Record<string, unknown>
let service: Record<string, unknown>
let containers: Record<string, unknown>[]
let extras: Record<string, unknown>[]
beforeEach(() => {
  pool = { name: 'PERSONAL_PHOTOS_UPLOAD_CPU', state: 'ACTIVE', num_jobs: 0, auto_resume: false }
  service = {
    name: 'PERSONAL_PHOTOS_UPLOAD',
    database_name: 'PERSONAL_MEDIA',
    schema_name: 'APP',
    status: 'RUNNING',
    auto_resume: false,
  }
  containers = [{ status: 'READY', instance_status: 'READY' }]
  extras = []
  sf.mockReset().mockImplementation(async (sql: string) => {
    if (sql.startsWith('SHOW COMPUTE')) return [pool]
    if (sql.startsWith('SHOW SERVICES')) return [service, ...extras]
    if (sql.startsWith('SHOW SERVICE CONTAINERS')) return containers
    return []
  })
})
it('suspends service before pool and waits for both to report suspended', async () => {
  expect(await uploadPoolStep('suspend')).toBe(false)
  expect(sf).toHaveBeenCalledWith('ALTER SERVICE PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_UPLOAD SUSPEND')
  expect(sf.mock.calls.some(([s]) => s.startsWith('ALTER COMPUTE'))).toBe(false)
  service.status = 'SUSPENDED'
  expect(await uploadPoolStep('suspend')).toBe(false)
  expect(sf).toHaveBeenCalledWith('ALTER COMPUTE POOL PERSONAL_PHOTOS_UPLOAD_CPU SUSPEND')
  pool.state = 'SUSPENDED'
  expect(await uploadPoolStep('suspend')).toBe(true)
})
it('resumes pool then service; never declares pending or unready containers healthy', async () => {
  pool.state = 'SUSPENDED'
  service.status = 'SUSPENDED'
  expect(await uploadPoolStep('pool')).toBe(false)
  expect(sf).toHaveBeenCalledWith('ALTER COMPUTE POOL PERSONAL_PHOTOS_UPLOAD_CPU RESUME')
  pool.state = 'ACTIVE'
  expect(await uploadPoolStep('pool')).toBe(false)
  expect(sf).toHaveBeenCalledWith('ALTER SERVICE PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_UPLOAD RESUME')
  service.status = 'RUNNING'
  containers = []
  expect(await uploadPoolStep('pool')).toBe(false)
  containers = [{ status: 'PENDING', instance_status: 'PENDING' }]
  expect(await uploadPoolStep('pool')).toBe(false)
  containers = [{ status: 'READY', instance_status: 'READY' }]
  expect(await uploadPoolStep('pool')).toBe(true)
  expect(sf.mock.calls.every(([s]) => /^(SHOW |ALTER (SERVICE|COMPUTE POOL) )/.test(s))).toBe(true)
})
it('refuses to suspend shared compute or resources that can auto-wake', async () => {
  extras = [{ name: 'OTHER_SERVICE' }]
  await expect(uploadPoolStep('suspend')).rejects.toThrow('another workload')
  extras = []
  pool.num_jobs = 1
  await expect(uploadPoolStep('suspend')).rejects.toThrow('another workload')
  pool.num_jobs = 0
  pool.num_services = 2
  await expect(uploadPoolStep('suspend')).rejects.toThrow('another workload')
  pool.num_services = 1
  service.auto_resume = true
  await expect(uploadPoolStep('suspend')).rejects.toThrow('auto-resume')
  expect(sf.mock.calls.every(([s]) => s.startsWith('SHOW '))).toBe(true)
})

it('resumes a suspending service when new upload intent arrives on an idle pool', async () => {
  pool.state = 'IDLE'
  service.status = 'SUSPENDING'
  expect(await uploadPoolStep('pool')).toBe(false)
  expect(sf).toHaveBeenCalledWith('ALTER SERVICE PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_UPLOAD RESUME')
  expect(sf.mock.calls.some(([s]) => s.startsWith('ALTER COMPUTE'))).toBe(false)
  service.status = 'PENDING'
  sf.mockClear()
  expect(await uploadPoolStep('pool')).toBe(false)
  expect(sf.mock.calls.some(([s]) => s.startsWith('ALTER '))).toBe(false)
  service.status = 'RUNNING'
  expect(await uploadPoolStep('pool')).toBe(true)
})
it('does not reissue suspension or stop the pool while the service is still suspending', async () => {
  service.status = 'SUSPENDING'
  expect(await uploadPoolStep('suspend')).toBe(false)
  expect(sf.mock.calls.every(([s]) => s.startsWith('SHOW '))).toBe(true)
  service.status = 'SUSPENDED'
  expect(await uploadPoolStep('suspend')).toBe(false)
  expect(sf).toHaveBeenCalledWith('ALTER COMPUTE POOL PERSONAL_PHOTOS_UPLOAD_CPU SUSPEND')
})
