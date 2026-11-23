/**
 * One way to build an in-memory PostgreSQL (PGlite) database for a test file.
 *
 * A test names what it needs and this helper assembles it in a fixed order:
 *
 *   1. a new PGlite instance (with pgvector and pg_trgm when `extensions` is set),
 *   2. `beforeSchema` SQL, then the `roles`,
 *   3. the schema snapshot `tests/fixtures/rls-schema.sql` (skip with `schema: false`),
 *   4. the `steps`, strictly in the order given.
 *
 * Example:
 *
 *   const db = await createTestDatabase({
 *     roles: ['snowflake_admin', 'personal_photos_app NOINHERIT'],
 *     steps: [
 *       { sql: 'SET search_path=public' },
 *       'setup/72-app-rls.sql',
 *       '202610072000_people_faces',
 *       { transaction: ['202610311200_gallery_statistics'] },
 *     ],
 *   })
 *
 * The caller owns the database and closes it (`await db.close()`), normally in `afterAll`.
 */
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { vector } from '@electric-sql/pglite-pgvector'
import { readFileSync } from 'node:fs'

/** The production schema as dumped, including row-level security; loaded unless `schema: false`. */
export const SCHEMA_SNAPSHOT = 'tests/fixtures/rls-schema.sql'

/**
 * One thing to run against the database.
 *
 * - A string names a SQL file. A bare name such as `'202610072000_people_faces'` (with or
 *   without `.sql`) is a migration in `migrations/postgres/`; anything containing a `/`,
 *   such as `'setup/72-app-rls.sql'`, is a path from the repository root.
 * - `{ sql }` runs SQL written in the test: grants, seed rows, stand-in tables.
 * - `{ file, withoutGrants: true }` runs a file with its GRANT statements removed (see
 *   `withoutGrants`).
 * - `{ transaction: [...] }` runs the named files together inside one BEGIN/COMMIT, for
 *   migrations that the real runner applies in a transaction (for example ones that use
 *   `SET LOCAL` or `LOCK TABLE`).
 */
export type TestDatabaseStep =
  string | { sql: string } | { file: string; withoutGrants: true } | { transaction: string[] }

export interface TestDatabaseOptions {
  /** Load the pgvector and pg_trgm extensions, which the People and search migrations need. */
  extensions?: boolean
  /** SQL to run on the empty database before roles and the schema snapshot. */
  beforeSchema?: string
  /**
   * Roles to create before the schema snapshot, which grants to them. Each entry is a role
   * name, optionally followed by role options: `'personal_photos_app NOINHERIT'`.
   */
  roles?: string[]
  /** Load the schema snapshot. Defaults to true; pass false to build the schema from `steps`. */
  schema?: boolean
  /** Files and SQL to apply after the snapshot, in order. */
  steps?: TestDatabaseStep[]
}

/** Resolves a step's file name to a path: bare names are migrations, paths are used as given. */
export function sqlFilePath(file: string): string {
  if (file.includes('/')) return file
  return `migrations/postgres/${file.endsWith('.sql') ? file : `${file}.sql`}`
}

/** Reads a setup or migration SQL file named the same way as a step. */
export function readSqlFile(file: string): string {
  return readFileSync(sqlFilePath(file), 'utf8')
}

/**
 * Removes every GRANT statement from a SQL file.
 *
 * Some setup files grant privileges to deployment roles (and on objects owned by them) that
 * a test database built without the schema snapshot does not have, and PGlite fails the
 * whole file on the first unknown role. Those grants belong to the deployment, not to the
 * behaviour under test, so such a file is applied without them. This is the only rewrite of
 * production SQL the helper performs.
 */
export function withoutGrants(sql: string): string {
  return sql.replace(/GRANT[^;]+;/g, '')
}

function stepSql(step: TestDatabaseStep): string {
  if (typeof step === 'string') return readSqlFile(step)
  if ('sql' in step) return step.sql
  if ('file' in step) return withoutGrants(readSqlFile(step.file))
  return `BEGIN;\n${step.transaction.map(readSqlFile).join('\n')}\nCOMMIT;`
}

/** Applies further steps to an existing test database, in order. */
export async function applyTestDatabaseSteps(db: PGlite, steps: TestDatabaseStep[]): Promise<void> {
  for (const step of steps) await db.exec(stepSql(step))
}

/** Creates a PGlite database, loads the schema snapshot and applies `steps` in order. */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<PGlite> {
  const db = options.extensions ? new PGlite({ extensions: { vector, pg_trgm } }) : new PGlite()
  try {
    if (options.beforeSchema) await db.exec(options.beforeSchema)
    if (options.roles?.length)
      await db.exec(options.roles.map((role) => `CREATE ROLE ${role};`).join(''))
    if (options.schema !== false) await db.exec(readFileSync(SCHEMA_SNAPSHOT, 'utf8'))
    await applyTestDatabaseSteps(db, options.steps ?? [])
    return db
  } catch (error) {
    await db.close()
    throw error
  }
}
