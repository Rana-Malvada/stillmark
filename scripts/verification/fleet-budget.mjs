/** Read-only deployment preflight. Counts must include rolling-release surge. */
import { postgresPoolMax } from '../../lib/database/postgres-pool-budget.ts'

process.env.PG_FLEET_BUDGET_REQUIRED = 'true'
try {
  for (const kind of ['app', 'maintenance', 'queue', 'independent']) postgresPoolMax(kind)
  console.log(
    'PASS configured fleet connection budget (including declared surge and batch connections)',
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
