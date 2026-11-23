import { pgQuery } from '../../lib/postgres'
import { WORKER_INTERRUPTED } from '../../lib/worker-cycle-recovery'

/** Retry infrastructure failures only; malformed media/configuration stays terminal. */
export function retryableWorkerFailure(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const { code, message, cause } = current as { code?: string; message?: string; cause?: unknown }
    if (
      typeof code === 'string' &&
      (code.startsWith('08') ||
        [
          '40001',
          '40P01',
          '53300',
          '53400',
          '57P01',
          '57P02',
          '57P03',
          'ECONNRESET',
          'ECONNREFUSED',
          'ETIMEDOUT',
          'EPIPE',
          'ENETUNREACH',
          'WORKER_TERMINATED',
        ].includes(code))
    )
      return true
    if (
      typeof message === 'string' &&
      /^(Connection terminated(?: unexpectedly| due to connection timeout)?|timeout exceeded when trying to connect|Query read timeout)$/.test(
        message,
      )
    )
      return true
    current = cause
  }
  return false
}

export async function recordPreparationFailure(runId: string, error: unknown) {
  const reason = retryableWorkerFailure(error)
    ? WORKER_INTERRUPTED
    : 'Worker stopped unexpectedly. Prepare videos again to retry unfinished files.'
  // Preserve terminal user actions, original cycle deadline and per-file leases.
  // If this write also fails, stale-run reconciliation still recovers the crash.
  await pgQuery(
    "UPDATE video_preparation_runs SET status='attention',accepting_work=false,error=$2,finished_at=NOW() WHERE id=$1 AND status IN ('starting','running')",
    [runId, reason],
  )
}
