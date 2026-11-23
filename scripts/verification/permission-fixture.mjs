/** Current synthetic catalog authority chain shared by permission and restore gates. */
import { readFileSync } from 'node:fs'

export async function createPermissionFixture(db) {
  const source = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
  await db.query(`CREATE ROLE snowflake_admin;
  CREATE ROLE personal_photos_app NOINHERIT;
  CREATE ROLE personal_photos_reader;
  CREATE ROLE personal_photos_video_worker;
  CREATE ROLE personal_photos_maintenance;`)
  await db.query(source('tests/fixtures/rls-schema.sql'))
  await db.query(`SET search_path=public;
  GRANT USAGE ON SCHEMA public TO personal_photos_app;
  GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO personal_photos_app;
  GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO personal_photos_app;`)
  for (const path of [
    'setup/71-catalog-read-rls.sql',
    'setup/72-app-rls.sql',
    'migrations/postgres/202610062030_gateway_security.sql',
    'migrations/postgres/202610280100_app_permissions.sql',
    'migrations/postgres/202610280110_app_permission_cardinality.sql',
    'migrations/postgres/202610280120_video_analysis_read_policy.sql',
    'migrations/postgres/202610280130_gateway_cleanup_index_cutoff.sql',
    'migrations/postgres/202610290220_assertion_cleanup_schema_access.sql',
    'migrations/postgres/202610251400_album_permission_queries.sql',
    'migrations/postgres/202610251430_permission_list_indexes.sql',
    'migrations/postgres/202610270130_indexed_app_photo_policy.sql',
    'migrations/postgres/202610072000_people_faces.sql',
    'migrations/postgres/202610301200_customer_registration.sql',
    'migrations/postgres/202610301500_customer_default_allowances.sql',
    'migrations/postgres/202610301600_shared_collection_accounts.sql',
    'migrations/postgres/202610302230_deleted_accounts.sql',
    'migrations/postgres/202610302235_no_automatic_folder.sql',
    'migrations/postgres/202610310300_deleted_account_archive_insert.sql',
    'migrations/postgres/202610242230_upload_routing.sql',
    'migrations/postgres/202610242350_upload_processing_queue.sql',
    'migrations/postgres/202610290200_upload_chunk_reservations.sql',
    'migrations/postgres/202611081510_upload_account_authority.sql',
    'migrations/postgres/202611142300_people_counts.sql',
    'migrations/postgres/202611180900_remembered_sessions.sql',
    'migrations/postgres/202611212300_people_counts_query_plans.sql',
  ])
    await db.query(source(path))
}
