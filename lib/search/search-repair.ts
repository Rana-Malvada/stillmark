import { objects } from '../../config/deployment.mjs'
import { databaseSignal } from '../database/database-context'
import { pgQuery } from '../postgres'
import { querySnowflake } from '../snowflake'

const PAGE_SIZE = 1000
const sources = [
  ['photo', objects.photoSearchTable, 'PHOTO_ID', 'photos', 'photo_id'],
  ['event', objects.eventSearchTable, 'EVENT_ID', 'events', 'event_id'],
] as const

function pageIds(rows: Record<string, unknown>[], key: string, after: number): number[] {
  const ids = [...new Set(rows.map((row) => Number(row[key])))]
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= after))
    throw new Error('Invalid search repair ID page')
  return ids.sort((a, b) => a - b)
}

/** Called only under the search-sync lock. Every page commits independently so an
 * interrupted repair can restart without losing deletion/publication evidence. */
export async function enqueueFullSearchRepair() {
  for (const [kind, remoteTable, remoteId, localTable, localId] of sources) {
    // Remote-only records include historical deletions. Mark these as attempted
    // before any publication; deleting a local record must not erase their cleanup.
    for (let after = 0; ;) {
      databaseSignal()?.throwIfAborted()
      const rows = await querySnowflake(
        `SELECT ${remoteId} AS ID FROM ${remoteTable} WHERE ${remoteId}>? ORDER BY ${remoteId} LIMIT ${PAGE_SIZE}`,
        { binds: [after] },
      )
      databaseSignal()?.throwIfAborted()
      const ids = pageIds(rows, 'ID', after)
      if (ids.length)
        await pgQuery(
          `INSERT INTO search_queue(kind,id,publication_attempted)
           SELECT $1,id,true FROM unnest($2::bigint[]) AS page(id)
           ON CONFLICT(kind,id) DO UPDATE SET revision=nextval('search_revision'),publication_attempted=true`,
          [kind, ids],
        )
      if (rows.length < PAGE_SIZE) break
      after = ids.at(-1)!
    }
    // Bound local repair writes too, rather than locking the entire outbox in a
    // single INSERT SELECT for a large catalog. Do not clear an existing marker.
    for (let after = 0; ;) {
      databaseSignal()?.throwIfAborted()
      const rows = await pgQuery<{ id: number }>(
        `SELECT ${localId} AS id FROM ${localTable} WHERE ${localId}>$1 ORDER BY ${localId} LIMIT ${PAGE_SIZE}`,
        [after],
      )
      const ids = pageIds(rows, 'id', after)
      if (ids.length)
        await pgQuery(
          `INSERT INTO search_queue(kind,id)
           SELECT $1,id FROM unnest($2::bigint[]) AS page(id)
           ON CONFLICT(kind,id) DO UPDATE SET revision=nextval('search_revision')`,
          [kind, ids],
        )
      if (rows.length < PAGE_SIZE) break
      after = ids.at(-1)!
    }
  }
}
