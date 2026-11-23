import { HttpError } from '../http'

export const claimUploadJobSql = `WITH ready AS (
 SELECT upload_id,next_attempt,created_at FROM upload_processing_jobs
 WHERE state='queued' AND next_attempt<=now()
 ORDER BY next_attempt,created_at FOR UPDATE SKIP LOCKED LIMIT 1
), expired AS (
 SELECT upload_id,next_attempt,created_at FROM upload_processing_jobs
 WHERE state='processing' AND lease_until<=now()
 ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT 1
), candidate AS (
 SELECT upload_id FROM (SELECT * FROM ready UNION ALL SELECT * FROM expired) eligible
 ORDER BY next_attempt,created_at LIMIT 1
) UPDATE upload_processing_jobs j SET state='processing',lease_token=$1,
 lease_until=now()+interval '5 minutes',attempts=j.attempts+1,executor=$2,updated_at=now()
 FROM candidate c WHERE j.upload_id=c.upload_id RETURNING j.*`
export function retryUploadJob(error: unknown, attempts: number) {
  return (
    attempts < 5 &&
    (!(error instanceof HttpError) ||
      [408, 409, 425, 429, 500, 502, 503, 504].includes(error.status))
  )
}
