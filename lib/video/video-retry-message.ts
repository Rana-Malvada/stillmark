export function preparationRetryMessage(
  row: { status: string; attempts: number; next_attempt_at: string; error: string },
  now: number,
) {
  const reason = /ENOTSUP|EIO|ECONNRESET|ETIMEDOUT|socket/i.test(row.error)
    ? 'A storage operation failed.'
    : 'The previous preparation attempt failed.'
  if (row.status === 'running') return `Retrying now (attempt ${row.attempts} of 3). ${reason}`
  const seconds = Math.max(0, Math.ceil((new Date(row.next_attempt_at).getTime() - now) / 1000))
  return `${seconds ? `Waiting to retry in ${seconds}s` : 'Retry is ready; waiting for a worker'} (attempt ${row.attempts + 1} of 3). ${reason}`
}
