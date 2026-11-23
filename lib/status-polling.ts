/** Check on return to the tab; repeat only while the last status indicates active work. */
export function watchProcessStatus(refresh: () => void, active: () => boolean) {
  const visibleRefresh = () => {
    if (!document.hidden) refresh()
  }
  const timer = setInterval(() => {
    if (active()) visibleRefresh()
  }, 5000)
  document.addEventListener('visibilitychange', visibleRefresh)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', visibleRefresh)
  }
}
export const processIsActive = (status?: string | null) =>
  ['queued', 'starting', 'running'].includes(status ?? '')
