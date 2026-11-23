import { recordPerformance } from './performance-metrics'

let active = 0
/** Best-effort usage analytics only. No queue and no impact on security-audit writes. */
export async function runActivityWork(work: () => Promise<void>): Promise<void> {
  const limit = Number(process.env.ACTIVITY_MAX_IN_FLIGHT ?? 16)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    console.error('[user-activity]', new Error('Invalid activity capacity'))
    return
  }
  if (active >= limit) {
    recordPerformance('activity-dropped', 0, 0, true)
    return
  }
  active++
  const started = performance.now()
  let failed = false
  try {
    await work()
  } catch {
    failed = true
    console.warn('[user-activity]')
  } finally {
    active--
    recordPerformance('activity-work', performance.now() - started, 0, failed)
  }
}
