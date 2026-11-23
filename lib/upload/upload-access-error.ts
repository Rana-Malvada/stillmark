export type UploadAccessIssue = 'authentication' | 'permission' | 'upstream'

/** Shared recovery contract for transfer requests and upload-pool startup. */
export function uploadAccessError(status: number, code: unknown, body = '') {
  if (status !== 401 && status !== 403) return null
  // The gateway's legacy plain-text 401 remains supported during coordinated releases.
  const authenticationRequired =
    status === 401 && (code === 'SESSION_REQUIRED' || body.trim() === 'Sign in required')
  const accessIssue: UploadAccessIssue = authenticationRequired
    ? 'authentication'
    : status === 403 && code === 'ACCESS_DENIED'
      ? 'permission'
      : 'upstream'
  const recoveryCode = authenticationRequired
    ? 'SESSION_REQUIRED'
    : accessIssue === 'permission'
      ? 'ACCESS_DENIED'
      : 'UPSTREAM_ACCESS_REJECTED'
  const detail = authenticationRequired
    ? 'Sign in again in a new tab, then resume here. Keep this upload tab open.'
    : accessIssue === 'permission'
      ? 'Upload permission was denied. Check your album and account access before resuming.'
      : 'The upload gateway or upstream service rejected this request. This does not necessarily mean your login expired.'
  return Object.assign(new Error(`${detail} (HTTP ${status}; ${recoveryCode})`), {
    status,
    code: recoveryCode,
    stopRetry: true as const,
    authenticationRequired,
    accessIssue,
  })
}
