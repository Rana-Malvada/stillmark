'use client'
import { isActivityPath } from './observability/activity-path'

export type BrowserActivity = {
  id: string
  path: string
  kind?: 'video_started' | 'video_watch' | 'video_error'
  seconds?: number
}
let pending: BrowserActivity[] = []
export function queueActivity(event: Omit<BrowserActivity, 'id'>) {
  if (!isActivityPath(event.path)) return
  pending.push({ ...event, id: crypto.randomUUID() })
  pending = pending.slice(-100)
  window.dispatchEvent(new Event('gallery-activity'))
}
export function pendingActivity() {
  return pending.slice(0, 20)
}
export function acknowledgeActivity(ids: Set<string>) {
  pending = pending.filter((e) => !ids.has(e.id))
}
