import { runActivityWork } from './activity-work'
import type { UsageDetails } from '@/lib/costs/usage-details'
import { after } from 'next/server'
import { requireAuth } from '@/lib/identity/auth'
import { recordAction } from '@/lib/observability/user-activity'
/** Best-effort analytics; never throw into a successful application action. */
export function trackAction(kind: string, target = '', details: UsageDetails = {}, key?: string) {
  try {
    after(() =>
      runActivityWork(async () => {
        const caller = await requireAuth()
        await recordAction(caller.username, kind, target, details, key)
      }),
    )
  } catch {
    console.warn('[user-activity] Action tracking unavailable')
  }
}

/** Read the owned durable upload session; never trust client byte counts or outcomes. */
export function trackUpload(
  stage: 'started' | 'completed' | 'failed',
  id: unknown,
  status?: number,
) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return
  try {
    after(() =>
      runActivityWork(async () => {
        const { pgQueryOne } = await import('@/lib/postgres')
        const caller = await requireAuth()
        const session = await pgQueryOne<{
          bytes: string
          result: { successCount?: number; skippedCount?: number; eventId?: number } | null
        }>('SELECT bytes,result FROM upload_sessions WHERE upload_id=$1 AND owner=$2', [
          id,
          caller.username,
        ])
        if (!session) return
        const outcome =
          stage === 'completed'
            ? session.result?.successCount
              ? 'success'
              : session.result?.skippedCount
                ? 'skipped'
                : 'unknown'
            : stage === 'failed'
              ? 'failed'
              : 'started'
        await recordAction(
          caller.username,
          `upload_${stage}`,
          `upload:${id}`,
          { bytes: Number(session.bytes), files: 1, outcome, status },
          id,
        )
      }),
    )
  } catch {
    console.warn('[user-activity] Upload tracking unavailable')
  }
}
