import { querySnowflake } from '../snowflake'
import { deployment } from '../../config/deployment.mjs'

const schema = `${deployment.DATABASE}.${deployment.APP_SCHEMA}`
const service = `${schema}.PERSONAL_PHOTOS_UPLOAD`
const pool = 'PERSONAL_PHOTOS_UPLOAD_CPU'

/** Only metadata/DDL. Never SELECT, CALL, USE WAREHOUSE or processing queries. */
export async function uploadPoolStep(desired: 'suspend' | 'pool'): Promise<boolean> {
  const pools = await querySnowflake(`SHOW COMPUTE POOLS LIKE '${pool}'`)
  const current = pools.find((row) => row.name === pool)
  if (!current) throw new Error('Upload compute pool was not found')
  const services = await querySnowflake(`SHOW SERVICES IN COMPUTE POOL ${pool}`)
  const own = services.find(
    (row) =>
      row.name === 'PERSONAL_PHOTOS_UPLOAD' &&
      row.database_name === deployment.DATABASE &&
      row.schema_name === deployment.APP_SCHEMA,
  )
  if (!own) throw new Error('Upload service was not found')
  if (desired === 'suspend') {
    if (
      services.some((row) => row !== own) ||
      Number(current.num_services) > 1 ||
      Number(current.num_jobs) > 0
    )
      throw new Error('Upload pool contains another workload; suspension was blocked')
    // Configured once by the provisioning owner; runtime has OPERATE, not ownership.
    if (
      String(own.auto_resume).toLowerCase() !== 'false' ||
      String(current.auto_resume).toLowerCase() !== 'false'
    )
      throw new Error('Disable upload service and pool auto-resume before enabling managed routing')
    // Suspension is asynchronous; repeating it can keep resetting the transition.
    if (own.status === 'SUSPENDING') return false
    if (own.status !== 'SUSPENDED') {
      await querySnowflake(`ALTER SERVICE ${service} SUSPEND`)
      return false
    }
    if (current.state !== 'SUSPENDED') {
      if (current.state !== 'STOPPING') await querySnowflake(`ALTER COMPUTE POOL ${pool} SUSPEND`)
      return false
    }
    return true
  }
  if (['FAILED', 'ERROR'].includes(String(current.state)) || own.status === 'FAILED')
    throw new Error('Upload infrastructure failed to start')
  if (current.state === 'SUSPENDED') {
    await querySnowflake(`ALTER COMPUTE POOL ${pool} RESUME`)
    return false
  }
  if (!['ACTIVE', 'IDLE'].includes(String(current.state))) return false
  // A new upload can arrive before an idle suspension finishes. RESUME also
  // cancels SUSPENDING; waiting for SUSPENDED can strand uploads indefinitely.
  if (own.status === 'SUSPENDED' || own.status === 'SUSPENDING') {
    await querySnowflake(`ALTER SERVICE ${service} RESUME`)
    return false
  }
  if (own.status !== 'RUNNING' || String(own.is_upgrading).toLowerCase() === 'true') return false
  const containers = await querySnowflake(`SHOW SERVICE CONTAINERS IN SERVICE ${service}`)
  // READY is backed by the upload container's HTTP readiness probe.
  return (
    containers.length > 0 &&
    containers.every((row) => row.status === 'READY' && row.instance_status === 'READY')
  )
}
