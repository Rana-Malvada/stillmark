import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { deployment, validateDeployment } from '../config/deployment.mjs'
import { renderDeployment } from '../config/render.mjs'

describe('deployment configuration trust boundary', () => {
  it.each([
    ['DATABASE', 'DB; DROP TABLE photos'],
    ['PHOTO_STAGE', "PHOTO_FILES'"],
    ['GATEWAY_ORIGIN', 'http://photos.example.com'],
    ['SNOWFLAKE_API_ORIGIN', 'https://attacker.example'],
    ['STORAGE_HOST', 'bucket.amazonaws.com.attacker.example'],
    ['GPU_IMAGE', '/db/schema/repo/worker:tag\nmalicious'],
    ['FACE_IMAGE', '/db/schema/repo/worker:tag;DROP'],
    ['GPU_IMAGE', '/db/schema/repo/worker:tag@sha256:abc'],
    ['GPU_IMAGE', '/db/schema/repo/worker:tag@sha256:' + 'g'.repeat(64)],
    ['FACE_POOL', 'POOL WITH x'],
    ['FACE_PG_USER', 'user; SELECT 1'],
    ['RESOURCE_PERSONAL_PHOTOS_ADMIN', 'ADMIN OR TRUE'],
    ['FACE_INSTANCE_FAMILY', 'GPU_NV_S'],
    ['FACE_INSTANCE_FAMILY', 'CPU_X64_L; DROP'],
    ['FACE_WORKER_CPU', '28'],
    ['FACE_WORKER_CPU', '0'],
    ['FACE_WORKER_CPU', '2.5'],
    ['FACE_WORKER_PARALLEL', '27'],
    ['FACE_WORKER_PARALLEL', '0'],
  ])('rejects unsafe %s', (key, value) => {
    expect(() => validateDeployment({ ...deployment, [key]: value })).toThrow()
  })
  it('rejects missing configuration rather than choosing another account', () => {
    expect(() => validateDeployment({ ...deployment, DATABASE: '' })).toThrow()
  })
  it('accepts exact SHA-256 image pins for worker releases', () => {
    const image = '/db/schema/repo/worker:release@sha256:' + 'a'.repeat(64)
    expect(validateDeployment({ ...deployment, GPU_IMAGE: image }).GPU_IMAGE).toBe(image)
    expect(validateDeployment({ ...deployment, FACE_IMAGE: image }).FACE_IMAGE).toBe(image)
  })
  it('renders an alternate account consistently without modifying production', () => {
    const alternate = {
      ...deployment,
      DATABASE: 'OTHER_MEDIA',
      APP_SCHEMA: 'WEB',
      RAW_SCHEMA: 'FILES',
      DATA_SCHEMA: 'SEARCH',
      SNOWFLAKE_ACCOUNT: 'OTHER-ACCOUNT',
      SNOWFLAKE_API_ORIGIN: 'https://other-account.snowflakecomputing.com',
      GATEWAY_ORIGIN: 'https://photos.example.com',
      GATEWAY_HOST: 'photos.example.com',
      PG_HOST: 'database.example.com',
      GPU_POOL: 'OTHER_GPU',
      PHOTO_STAGE: 'ORIGINAL_MEDIA',
    }
    for (const file of [
      'app.yml',
      'cloudflare-gateway/wrangler.jsonc',
      'workers/video-gpu/production-spec.json',
      'workers/video-gpu/provision.sql',
      'video-control.sql',
    ]) {
      const template = readFileSync('config/templates/' + file, 'utf8')
      const result = renderDeployment(template, alternate)
      expect(result).not.toContain('{{')
      expect(result).not.toContain('PERSONAL_MEDIA')
      expect(result).not.toContain('photos.stillmark.example')
      expect(result).not.toContain(deployment.PG_HOST)
    }
  })
  it('rejects unknown template keys', () => {
    expect(() => renderDeployment('{{MISSING_SETTING}}', deployment)).toThrow()
  })
  it('sizes face scan memory from the node and CPU, never past the node', () => {
    const size = (family: string, cpu: string) =>
      validateDeployment({
        ...deployment,
        FACE_INSTANCE_FAMILY: family,
        FACE_WORKER_CPU: cpu,
        FACE_WORKER_PARALLEL: cpu,
      }).FACE_WORKER_MEMORY
    expect(size('CPU_X64_L', '26')).toBe('98Gi')
    expect(size('CPU_X64_S', '2')).toBe('8Gi')
    expect(size('CPU_X64_SL', '13')).toBe('49Gi')
    expect(size('CPU_X64_M', '6')).toBe('23Gi')
    expect(size('CPU_X64_S', '3')).toBe('11Gi')
    expect(() => size('CPU_X64_M', '7')).toThrow()
    expect(() => size('CPU_X64_S', '4')).toThrow()
  })
})
