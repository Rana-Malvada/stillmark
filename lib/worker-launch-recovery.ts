import { pgQueryOne } from './postgres'

/** Called while holding the run's launch advisory lock. Persist before contacting
 * Snowflake, so coordinator loss cannot erase backoff or extend the deadline. */
export async function reserveWorkerLaunch(
  table: 'face_scan_runs' | 'video_preparation_runs',
  id: string,
) {
  return !!(await pgQueryOne(
    `UPDATE ${table}
     SET next_launch_at=now()+make_interval(secs=>LEAST(300,15*power(2,LEAST(launch_attempts,5)))::int),
         launch_attempts=launch_attempts+1
     WHERE id=$1 AND status='starting' AND next_launch_at<=now()
       AND created_at>now()-interval '30 minutes'
     RETURNING id`,
    [id],
  ))
}
