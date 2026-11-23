import { querySnowflake } from '../snowflake'
import { deployment } from '../../config/deployment.mjs'
import workerSpec from '../../config/search-worker-spec.json'
import { flagOn } from '../flags'

type Action = 'START' | 'STATUS' | 'CANCEL' | 'SETTLE'
const schema = `${deployment.DATABASE}.${deployment.APP_SCHEMA}`

/** Direct metadata/DDL only. CALL and SELECT would require a warehouse, even
 * when a stored procedure only orchestrates a CPU job. Do not add them here. */
export async function searchBatchCommand(id: string, action: Action, deadline?: number) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
    throw new Error('Invalid run ID')
  if (!['START', 'STATUS', 'CANCEL', 'SETTLE'].includes(action)) throw new Error('Invalid action')
  const name = `SEARCH_BATCH_${id.replaceAll('-', '').toUpperCase()}`
  const jobs = await querySnowflake(`SHOW JOB SERVICES LIKE '${name}' IN SCHEMA ${schema}`)
  const existing = jobs.find((row) => row.name === name)
  let status = String(existing?.status ?? 'NOT_FOUND')
  // Existing jobs remain on their original pool during the rollout.
  const poolName =
    existing?.compute_pool === deployment.FACE_POOL ? deployment.FACE_POOL : deployment.SEARCH_POOL
  const readPool = async () => {
    const rows = await querySnowflake(`SHOW COMPUTE POOLS LIKE '${poolName}'`)
    const row = rows.find((item) => item.name === poolName)
    if (!row) throw new Error('Search compute pool unavailable')
    return {
      state: String(row.state),
      jobs: Number(row.num_jobs),
      services: Number(row.num_services),
    }
  }
  if (action === 'CANCEL') {
    await querySnowflake(`DROP SERVICE IF EXISTS ${schema}.${name}`)
    status = 'CANCELLED'
  }
  if (action === 'START' && status === 'NOT_FOUND') {
    if (deadline !== undefined && (!Number.isFinite(deadline) || deadline - Date.now() < 90000))
      throw new Error('Search update time limit reached')
    const summaries = flagOn('TRAVEL_SUMMARIES_ENABLED')
    const summaryLimit = Number(process.env.TRAVEL_SUMMARY_MAX_ALBUMS ?? 100)
    if (
      summaries &&
      (!Number.isSafeInteger(summaryLimit) || summaryLimit < 1 || summaryLimit > 1000)
    )
      throw new Error('Invalid TRAVEL_SUMMARY_MAX_ALBUMS')
    const pool = await readPool()
    if (pool.state === 'SUSPENDED') await querySnowflake(`ALTER COMPUTE POOL ${poolName} RESUME`)
    const spec = structuredClone(workerSpec)
    spec.spec.containers[0].env.WORKER_RUN_ID = id
    Object.assign(spec.spec.containers[0].env, {
      TRAVEL_SUMMARIES_ENABLED: String(summaries),
      TRAVEL_SUMMARY_MAX_ALBUMS: String(summaries ? summaryLimit : 100),
    })
    if (deadline !== undefined) {
      if (!Number.isFinite(deadline) || deadline - Date.now() < 90000)
        throw new Error('Search update time limit reached')
      Object.assign(spec.spec.containers[0].env, {
        SEARCH_UPDATE_DEADLINE: String(Math.floor(deadline / 1000)),
      })
      // Compute the remaining allowance in the container, AFTER provisioning/model
      // scheduling delays. TERM plus KILL remain inside the original deadline.
      spec.spec.containers[0].command = ['/bin/sh']
      spec.spec.containers[0].args = [
        '-c',
        'remaining=$((SEARCH_UPDATE_DEADLINE - $(date +%s))); [ "$remaining" -gt 60 ] || exit 0; work=$((remaining - 30)); [ "$work" -le 3000 ] || work=3000; export WORKER_MAX_SECONDS="$work"; hard=$((remaining - 5)); [ "$hard" -le 3300 ] || hard=3300; exec /usr/bin/timeout --kill-after=5s "$hard" python /worker/worker.py',
      ]
    }
    // Snowflake consumes backslash escapes inside single-quoted SQL strings.
    // Preserve JSON's escaped shell quotes through that first decoding layer.
    const literal = JSON.stringify(spec).replaceAll('\\', '\\\\').replaceAll("'", "''")
    try {
      await querySnowflake(
        `EXECUTE JOB SERVICE IN COMPUTE POOL ${poolName} NAME=${schema}.${name} EXTERNAL_ACCESS_INTEGRATIONS=(PERSONAL_PHOTOS_SEARCH_EAI) ASYNC=TRUE FROM SPECIFICATION '${literal}'`,
      )
    } catch (error) {
      // Submission may succeed before its response times out. Never launch a second job.
      const existing = await querySnowflake(`SHOW JOB SERVICES LIKE '${name}' IN SCHEMA ${schema}`)
      if (!existing.some((row) => row.name === name)) throw error
    }
    status = 'PENDING'
  }
  const pool = await readPool()
  const ended = ['CANCELLED', 'DONE', 'FAILED', 'NOT_FOUND'].includes(status)
  if (
    (action === 'CANCEL' || action === 'SETTLE') &&
    ended &&
    pool.jobs === 0 &&
    pool.services === 0 &&
    pool.state !== 'SUSPENDED'
  ) {
    await querySnowflake(`ALTER COMPUTE POOL ${poolName} SUSPEND`)
    pool.state = 'SUSPENDING'
  }
  return { status, job: name, pool: pool.state, containers: [] }
}
