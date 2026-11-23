import { randomUUID } from 'node:crypto'
import { pgQuery, pgQueryOne, pgTransaction } from './postgres'

export const WORKER_INTERRUPTED = 'Worker interrupted; automatic recovery pending'
/** A new deterministic job ID, but the same deadline and finite crash budget.
 * Caller holds the launch advisory lock. Row locks also fence Stop/publication. */
export async function recoverWorkerCycle(kind: 'faces' | 'playback') {
  const face = kind === 'faces'
  const runs = face ? 'face_scan_runs' : 'video_preparation_runs'
  const queue = face ? 'face_scan_queue' : 'video_playback'
  const runColumn = face ? 'run_id' : 'preparation_run_id'
  return pgTransaction(async () => {
    if (await pgQueryOne(`SELECT 1 FROM ${runs} WHERE status IN ('starting','running')`))
      return null
    const prior = await pgQueryOne<{
      id: string
      requested_by: string
      kind: string
      cycle_deadline: string
      recovery_attempts: number
      organization_pending?: boolean
    }>(
      `SELECT * FROM ${runs} r WHERE status='attention' AND error=$1
       AND recovery_attempts<3 AND cycle_deadline>now()
       AND finished_at<=now()-make_interval(secs=>30*power(2,recovery_attempts)::int)
       AND NOT EXISTS(SELECT 1 FROM ${runs} child WHERE child.continued_from=r.id)
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [WORKER_INTERRUPTED],
    )
    if (!prior) return null
    // Only reclaim interrupted work after its lease expires; never reset the
    // per-file attempt counter or retry a terminal bad-media failure.
    await pgQuery(
      `UPDATE ${queue} SET status='queued',claim_token=NULL,lease_until=NULL
       WHERE ${runColumn}=$1 AND status='running' AND lease_until<now() AND attempts<3 RETURNING photo_id`,
      [prior.id],
    )
    await pgQuery(
      `UPDATE ${queue} SET status='failed',claim_token=NULL,lease_until=NULL,error='Worker retry limit reached'
      WHERE ${runColumn}=$1 AND status='running' AND lease_until<now() AND attempts>=3`,
      [prior.id],
    )
    if (
      !(face && prior.organization_pending) &&
      !(await pgQueryOne(
        `SELECT 1 FROM ${queue} WHERE ${runColumn}=$1 AND status='queued' AND attempts<3 LIMIT 1`,
        [prior.id],
      ))
    )
      return null
    // Wait for every live claim before handing over the snapshot.
    if (
      await pgQueryOne(
        `SELECT 1 FROM ${queue} WHERE ${runColumn}=$1 AND status='running' AND lease_until>now() LIMIT 1`,
        [prior.id],
      )
    )
      return null
    const id = randomUUID()
    await pgQuery(
      `INSERT INTO ${runs}(id,requested_by,status,cycle_deadline,continued_from,recovery_attempts${face ? ',kind,photo_limit,organization_pending' : ''})
       VALUES($1,$2,'starting',$3,$4,$5${face ? ',$6,100000,$7' : ''})`,
      [
        id,
        prior.requested_by,
        prior.cycle_deadline,
        prior.id,
        prior.recovery_attempts + 1,
        ...(face ? [prior.kind, prior.organization_pending ?? false] : []),
      ],
    )
    const moved = await pgQuery(
      `UPDATE ${queue} SET ${runColumn}=$1,next_attempt_at=now()
       WHERE ${runColumn}=$2 AND status='queued' AND attempts<3 RETURNING photo_id`,
      [id, prior.id],
    )
    return await pgQueryOne(`UPDATE ${runs} SET total=$2 WHERE id=$1 RETURNING *`, [
      id,
      moved.length,
    ])
  })
}
