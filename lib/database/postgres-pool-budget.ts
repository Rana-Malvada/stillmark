/** Per-process limits. Deployment replica counts must fit the database connection budget. */
type PoolKind = 'app' | 'maintenance' | 'queue' | 'independent'
/** Sizes used when the matching PG_*_POOL_MAX variable is unset. */
const DEFAULT_WORK_POOL_MAX = 10
const DEFAULT_SIDE_POOL_MAX = 2
export function postgresPoolMax(kind: PoolKind): number {
  validateConfiguredFleet()
  return poolLimit(kind)
}
function poolLimit(kind: PoolKind): number {
  const name = {
    app: 'PG_APP_POOL_MAX',
    maintenance: 'PG_MAINTENANCE_POOL_MAX',
    queue: 'PG_QUEUE_POOL_MAX',
    independent: 'PG_INDEPENDENT_POOL_MAX',
  }[kind]
  const value = process.env[name]
  if (value === undefined)
    return kind === 'queue' || kind === 'independent'
      ? DEFAULT_SIDE_POOL_MAX
      : DEFAULT_WORK_POOL_MAX
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 100)
    throw new Error(`${name} must be an integer between 1 and 100`)
  return Number(value)
}

export interface FleetConnectionBudget {
  appProcesses: number
  uploadProcesses: number
  otherConnections: number
  availableConnections: number
  pools: { app: number; maintenance: number; queue: number; independent: number }
}
/** Includes both credential-specific independent pools and both possible session
 * pools. Conservative for direct Postgres, where session pools reuse base pools.
 * Process counts must include rolling-release surge, not just steady replicas. */
export function validateFleetConnectionBudget(config: FleetConnectionBudget): number {
  for (const n of [
    config.appProcesses,
    config.uploadProcesses,
    config.otherConnections,
    config.availableConnections,
    ...Object.values(config.pools),
  ])
    if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid fleet connection budget')
  const perProcess =
    config.pools.app + config.pools.maintenance + config.pools.queue + 4 * config.pools.independent
  const total =
    perProcess * (config.appProcesses + config.uploadProcesses) + config.otherConnections
  if (!Number.isSafeInteger(total) || total > config.availableConnections)
    throw Error(
      `Fleet database connection budget exceeded: ${total} requested, ${config.availableConnections} available`,
    )
  return total
}
function validateConfiguredFleet() {
  const keys = [
    'PG_FLEET_CONNECTION_BUDGET',
    'PG_FLEET_APP_PROCESSES',
    'PG_FLEET_UPLOAD_PROCESSES',
    'PG_FLEET_OTHER_CONNECTIONS',
  ]
  if (
    !keys.some((key) => process.env[key] !== undefined) &&
    process.env.PG_FLEET_BUDGET_REQUIRED !== 'true'
  )
    return
  if (keys.some((key) => !/^\d+$/.test(process.env[key] ?? '')))
    throw Error('All PG_FLEET budget values must be configured as nonnegative integers')
  validateFleetConnectionBudget({
    availableConnections: Number(process.env.PG_FLEET_CONNECTION_BUDGET),
    appProcesses: Number(process.env.PG_FLEET_APP_PROCESSES),
    uploadProcesses: Number(process.env.PG_FLEET_UPLOAD_PROCESSES),
    otherConnections: Number(process.env.PG_FLEET_OTHER_CONNECTIONS),
    pools: {
      app: poolLimit('app'),
      maintenance: poolLimit('maintenance'),
      queue: poolLimit('queue'),
      independent: poolLimit('independent'),
    },
  })
}
