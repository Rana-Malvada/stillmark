import { withServiceDatabase } from '../database/database-context'
import { pgQuery } from '../postgres'

/** Durable queue; SQL locks one owner's batch, retries naturally after a failure. */
export async function maintainPeopleMatching() {
  return withServiceDatabase(() => pgQuery('SELECT * FROM face_worker.rematch_batch(100)'))
}
