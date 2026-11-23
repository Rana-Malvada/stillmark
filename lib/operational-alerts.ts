export interface OperationalAlert {
  code: string
  message: string
}
export function operationalAlerts(data: {
  sync: { last_error: string | null } | null
  failures: { ai_attempts: number }[]
  cleanup: unknown[]
  uploads: { status: string }[]
}): OperationalAlert[] {
  const alerts: OperationalAlert[] = []
  if (data.sync?.last_error)
    alerts.push({
      code: 'search-sync',
      message: 'The last search sync failed. Review its status below before retrying.',
    })
  const exhausted = data.failures.filter((f) => f.ai_attempts >= 3).length
  if (exhausted)
    alerts.push({
      code: 'ai-retries',
      message: `${exhausted} visible files need attention after repeated AI failures.`,
    })
  if (data.cleanup.length)
    alerts.push({
      code: 'cleanup',
      message: 'Storage cleanup has failed work. Review the failures below.',
    })
  if (data.uploads.some((u) => u.status === 'FAILED'))
    alerts.push({
      code: 'uploads',
      message: 'Recent visible uploads include failures. Review the file results below.',
    })
  return alerts
}
