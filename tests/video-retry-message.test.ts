import { expect, it } from 'vitest'
import { preparationRetryMessage } from '@/lib/video/video-retry-message'

it('distinguishes retry delay, worker wait and active retry', () => {
  const now = Date.now()
  const row = {
    status: 'queued',
    attempts: 1,
    next_attempt_at: new Date(now + 10000).toISOString(),
    error: 'ENOTSUP: socket, close',
  }
  expect(preparationRetryMessage(row, now)).toContain(
    'Waiting to retry in 10s (attempt 2 of 3). A storage operation failed.',
  )
  expect(preparationRetryMessage(row, now + 11000)).toContain('waiting for a worker')
  expect(preparationRetryMessage({ ...row, status: 'running', attempts: 2 }, now)).toContain(
    'Retrying now (attempt 2 of 3)',
  )
})
