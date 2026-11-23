import { readFileSync } from 'node:fs'
import type { PGlite } from '@electric-sql/pglite'
/** Older integration fixtures use the owner connection rather than request RLS.
 * Install the real additive migrations; dedicated RLS tests exercise app roles. */
export async function installUploadQueue(db: PGlite) {
  await db.exec(`CREATE ROLE personal_photos_maintenance;
 CREATE FUNCTION photo_security.username() RETURNS text LANGUAGE sql STABLE AS $$SELECT 'fixture'::text$$;
 CREATE FUNCTION photo_security.flag(n text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;`)
  await db.exec(readFileSync('migrations/postgres/202610242230_upload_routing.sql', 'utf8'))
  await db.exec(
    readFileSync('migrations/postgres/202610242350_upload_processing_queue.sql', 'utf8'),
  )
  await db.exec(
    readFileSync('migrations/postgres/202610290200_upload_chunk_reservations.sql', 'utf8'),
  )
}
