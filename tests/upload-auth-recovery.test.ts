import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppPermissionIdentity } from '@/lib/app-permissions'
import type { uploadFile as sendUpload } from '@/lib/upload/upload-client'

const identity: AppPermissionIdentity = {
  name: 'ALICE',
  marker: 'test-marker',
  revoked: false,
  epoch: '1',
  enabled: true,
  app_role: 'viewer',
  app_owner: false,
  can_manage_personal: true,
  can_manage_access: false,
  main_admin: false,
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

async function identityResponse(row: AppPermissionIdentity | undefined) {
  const { appPermissionIdentity } = await import('@/lib/app-permissions')
  const { apiError } = await import('@/lib/http')
  try {
    appPermissionIdentity(row)
    throw new Error('Expected identity rejection')
  } catch (error) {
    return apiError(error)
  }
}

it.each(['missing', 'revoked'] as const)(
  'propagates a %s identity through the API to upload authentication recovery',
  async (state) => {
    const { checkUploadJobs } = await import('@/lib/upload/upload-client')
    const fetchMock = vi.fn(() =>
      identityResponse(state === 'missing' ? undefined : { ...identity, revoked: true }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(checkUploadJobs(['saved-upload'])).rejects.toMatchObject({
      status: 401,
      code: 'SESSION_REQUIRED',
      authenticationRequired: true,
      accessIssue: 'authentication',
      stopRetry: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  },
)

it('distinguishes a forged gateway assertion from a session that can be renewed', async () => {
  const { verifyGatewayAssertion } = await import('@/lib/identity/gateway-assertion')
  const { apiError } = await import('@/lib/http')
  const { checkUploadJobs } = await import('@/lib/upload/upload-client')
  const fetchMock = vi.fn(() => {
    try {
      verifyGatewayAssertion('forged.assertion', 'ab'.repeat(32), 'https://app')
    } catch (error) {
      return Promise.resolve(apiError(error))
    }
    throw new Error('Expected gateway rejection')
  })
  vi.stubGlobal('fetch', fetchMock)
  await expect(checkUploadJobs(['saved-upload'])).rejects.toMatchObject({
    status: 401,
    code: 'UPSTREAM_ACCESS_REJECTED',
    authenticationRequired: false,
    accessIssue: 'upstream',
    stopRetry: true,
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('classifies an inactive gallery identity as permission denial without a transport retry', async () => {
  const { checkUploadJobs } = await import('@/lib/upload/upload-client')
  const fetchMock = vi.fn(() => identityResponse({ ...identity, enabled: false }))
  vi.stubGlobal('fetch', fetchMock)
  await expect(checkUploadJobs(['saved-upload'])).rejects.toMatchObject({
    status: 403,
    code: 'ACCESS_DENIED',
    authenticationRequired: false,
    accessIssue: 'permission',
    stopRetry: true,
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('retains queued files and stable upload IDs while a revoked session pauses and resumes', async () => {
  const { uploadFile } = await import('@/lib/upload/upload-client')
  const { UploadQueue } = await import('@/lib/upload/upload-queue')
  let revoked = true
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === '/api/upload/routing')
      return revoked
        ? identityResponse({ ...identity, revoked: true })
        : Response.json({ ready: true })
    if (url === '/api/auth/me')
      return Response.json({
        authenticated: true,
        username: identity.name,
        canManagePersonal: true,
      })
    if (url.startsWith('/api/upload/chunk?'))
      return Response.json({
        // GET /api/upload/chunk includes session/chunk metadata even after completion.
        exists: true,
        chunks: [0],
        totalChunks: 1,
        result: { eventId: 42, results: [{ status: 'success', photoId: 7 }] },
      })
    throw new Error(`Unexpected upload request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  // Use the real upload client, suppressing only browser XHR progress reporting.
  const send = vi.fn((...args: Parameters<typeof sendUpload>) =>
    uploadFile(args[0], args[1], undefined, args[3], args[4]),
  )
  const completed = vi.fn()
  const queue = new UploadQueue(send, completed)
  const files = Array.from({ length: 6 }, (_, i) => new File(['image'], `${i}.jpg`))
  const batchId = queue.start(files, { eventId: 42 }, 'Trip')
  await vi.waitFor(() => expect(queue.snapshot()[0].running).toBe(false))
  expect(send).toHaveBeenCalledTimes(4)
  expect(fetchMock).toHaveBeenCalledTimes(1) // Concurrent files share the startup denial.
  expect(completed).not.toHaveBeenCalled()
  expect(queue.snapshot()[0].accessIssue).toBe('authentication')
  expect(queue.snapshot()[0].needsFiles).toBeFalsy()
  expect(queue.snapshot()[0].warning).toContain('Sign in again in a new tab')
  expect(queue.snapshot()[0].files.map((file) => file.phase)).toEqual(Array(6).fill('failed'))
  const originalIds = send.mock.calls.map((call) => call[3])

  revoked = false
  await queue.resume(batchId, identity.name)
  await vi.waitFor(() => expect(queue.snapshot()[0].running).toBe(false))
  expect(send).toHaveBeenCalledTimes(10)
  files.forEach((file, index) => expect(send.mock.calls[index + 4][0]).toBe(file))
  originalIds.forEach((id, index) => expect(send.mock.calls[index + 4][3]).toBe(id))
  expect(queue.snapshot()[0].files.map((file) => file.phase)).toEqual(Array(6).fill('success'))
  expect(queue.snapshot()[0].accessIssue).toBeUndefined()
  expect(completed).toHaveBeenCalledWith(42)
  expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false)
})
