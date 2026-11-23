import { afterEach, expect, it, vi } from 'vitest'
import { uploadServiceRequestAllowed } from '../lib/upload-service-policy.mjs'
import { uploadLimit, withUploadCompletionCapacity } from '../lib/upload/upload-capacity'

afterEach(() => vi.unstubAllEnvs())
it('limits completion memory per replica and releases capacity on failure', async () => {
  vi.stubEnv('UPLOAD_COMPLETIONS_PER_INSTANCE', '1')
  let finish!: () => void
  const running = withUploadCompletionCapacity(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await expect(withUploadCompletionCapacity(async () => 'duplicate')).rejects.toMatchObject({
    status: 429,
  })
  finish()
  await running
  await expect(
    withUploadCompletionCapacity(async () => {
      throw Error('interrupted')
    }),
  ).rejects.toThrow('interrupted')
  await expect(withUploadCompletionCapacity(async () => 'retry')).resolves.toBe('retry')
})
it('rejects invalid capacity configuration rather than disabling limits', () => {
  for (const value of ['0', '-1', '1.5', '', 'Infinity', '10001', 'abc']) {
    vi.stubEnv('UPLOAD_SESSIONS_GLOBAL', value)
    expect(() => uploadLimit('UPLOAD_SESSIONS_GLOBAL', 8)).toThrow()
  }
})
it('upload-only service excludes administrative, public-share and gallery routes', () => {
  for (const path of [
    '/',
    '/api/events',
    '/api/upload',
    '/api/upload/chunk/extra',
    '/api/admin',
    '/share/token',
  ])
    for (const method of ['GET', 'POST', 'DELETE'])
      expect(uploadServiceRequestAllowed(path, method)).toBe(false)
  expect(uploadServiceRequestAllowed('/api/upload/complete', 'GET')).toBe(false)
  expect(uploadServiceRequestAllowed('/api/upload/complete', 'POST')).toBe(true)
  expect(uploadServiceRequestAllowed('/api/health/live', 'GET')).toBe(true)
})

it('upload-only runtime blocks UI and unsigned transport before route execution', async () => {
  const { proxy } = await import('../proxy')
  const { NextRequest } = await import('next/server')
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'true')
  const authenticated = {
    'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY',
    'sf-context-current-user-token': 'platform-token',
    'x-photo-gateway-identity': 'signed-assertion',
  }
  expect(
    proxy(new NextRequest('https://example.com/api/events', { headers: authenticated })).status,
  ).toBe(404)
  expect(
    proxy(
      new NextRequest('https://example.com/api/upload/chunk', {
        headers: {
          'sf-context-current-user': 'PERSONAL_PHOTOS_GATEWAY',
          'sf-context-current-user-token': 'platform-token',
        },
      }),
    ).status,
  ).toBe(401)
  const response = proxy(
    new NextRequest('https://example.com/api/upload/chunk', {
      method: 'POST',
      headers: authenticated,
    }),
  )
  expect(response.headers.get('x-middleware-next')).toBe('1')
  expect(response.headers.get('x-middleware-request-x-photo-request-method')).toBe('POST')
})

it('bounds chunk buffering independently of completion capacity', async () => {
  const { withUploadChunkCapacity } = await import('../lib/upload/upload-capacity')
  vi.stubEnv('UPLOAD_CHUNKS_PER_INSTANCE', '1')
  let finish!: () => void
  const receiving = withUploadChunkCapacity(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await expect(withUploadChunkCapacity(async () => 'extra')).rejects.toMatchObject({ status: 429 })
  await expect(withUploadCompletionCapacity(async () => 'complete')).resolves.toBe('complete')
  finish()
  await receiving
  await expect(withUploadChunkCapacity(async () => 'retry')).resolves.toBe('retry')
})
