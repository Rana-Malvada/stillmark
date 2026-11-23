/**
 * Run real route handlers against a real PostgreSQL (PGlite) database, under the same
 * row-level security the deployed application has.
 *
 * Nothing in `lib/` is replaced. A test that uses this file mocks only the edges of the
 * process:
 *
 *   - `pg`, the network driver: `pgliteDriver` gives `lib/postgres.ts` a connection pool
 *     whose connections are the PGlite database. The real `lib/postgres.ts` therefore
 *     opens its own transactions, binds the caller with `set_config('photos.…')` and is
 *     subject to every policy, exactly as in production. Each pool acts as its database
 *     login: `personal_photos_app` for requests, `personal_photos_maintenance` for
 *     service work, `personal_photos_upload_queue` for the upload worker. None of them
 *     can bypass row-level security.
 *   - `next/headers`, the platform-verified caller: `callerHeaders` builds the headers the
 *     platform attaches to a signed-in request. The real `lib/identity/auth.ts` reads them.
 *   - `@/lib/snowflake`, the role provider: `snowflakeRoleRows` answers the one role
 *     question `lib/identity/auth.ts` asks about the signed-in caller.
 *
 * Wiring, in the test file (vi.mock calls are hoisted, so they stay in the test):
 *
 *   const s = vi.hoisted(() => ({ db: null as any, headers: new Headers(), caller: null as any }))
 *   vi.mock('pg', async () =>
 *     (await import('./fixtures/route-database')).pgliteDriver(
 *       await vi.importActual<typeof import('pg')>('pg'), () => s.db))
 *   vi.mock('next/headers', () => ({ headers: async () => s.headers }))
 *
 * The database is the schema snapshot, the row-level security setup and then every
 * migration in `migrations/postgres/`, in order: the schema a deployment has.
 */
import { createTestDatabase } from './test-database'
import type { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'

/** Database logins and group roles the setup files and migrations grant to. */
const ROLES = [
  'snowflake_admin',
  'personal_photos_app NOINHERIT',
  'personal_photos_reader',
  'personal_photos_video_worker',
  'personal_photos_maintenance',
  'personal_photos_search_worker',
  'personal_photos_face_worker',
]

/** The deployed schema: snapshot, row-level security, then every migration in order. */
export async function createRouteDatabase(): Promise<PGlite> {
  const migrations = readdirSync('migrations/postgres')
    .filter((name) => name.endsWith('.sql'))
    .sort()
  return createTestDatabase({
    extensions: true,
    roles: ROLES,
    steps: [
      {
        // The web login's privileges on the original tables predate the setup files.
        sql: `SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app;
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO personal_photos_app;
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO personal_photos_app;`,
      },
      'setup/72-app-rls.sql',
      // The migration runner applies each file in its own transaction.
      ...migrations.map((name) => ({ transaction: [name] })),
    ],
  })
}

/** Environment `lib/postgres.ts` needs to build its pools; no host is ever contacted. */
export const DATABASE_ENV = {
  PG_HOST: 'pglite.invalid',
  PG_PORT: '5432',
  PG_USER: 'personal_photos_app',
  PG_PASSWORD: 'not-a-real-credential',
  PG_MAINTENANCE_PASSWORD: 'not-a-real-credential',
  PG_UPLOAD_QUEUE_PASSWORD: 'not-a-real-credential',
  PG_SSL: 'false',
} as const

// node-postgres returns bigint and numeric columns as text; PGlite would return numbers.
const PARSERS = { 20: (value: string) => value, 1700: (value: string) => value }
/** How long one connection may wait for the single PGlite session before the test fails. */
const SESSION_WAIT_MS = 5000

type Result = { rows: unknown[]; rowCount: number; command?: string }

/**
 * A stand-in for the `pg` module whose pools all lead to one PGlite database.
 *
 * PGlite is a single session, so connections take turns: a connection holds the session
 * from its `BEGIN` to its `COMMIT`/`ROLLBACK` (or for one statement outside a
 * transaction) and runs as its pool's login for that time. Code that truly needs two
 * connections at once (a second connection while the first is inside a transaction)
 * cannot run here and fails with a clear error instead of hanging.
 */
export function pgliteDriver(actual: typeof import('pg'), database: () => PGlite) {
  let held: object | null = null
  const waiting: Array<() => void> = []
  async function take(owner: object) {
    if (held === owner) return
    const started = Date.now()
    while (held) {
      if (Date.now() - started > SESSION_WAIT_MS)
        throw new Error('Test database: a second connection was needed inside a transaction')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50)
        waiting.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    held = owner
  }
  function give(owner: object) {
    if (held !== owner) return
    held = null
    waiting.shift()?.()
  }
  class Pool {
    options: { user?: string; port?: number; max?: number; password?: unknown }
    waitingCount = 0
    totalCount = 0
    idleCount = 0
    constructor(options: Pool['options']) {
      this.options = options
    }
    on() {
      return this
    }
    async end() {}
    /** One statement on a connection of its own, as `pool.query` does in node-postgres. */
    async query(input: string | { text: string; values?: unknown[] }, values?: unknown[]) {
      const client = await this.connect()
      try {
        return await client.query(input, values)
      } finally {
        await client.release()
      }
    }
    async connect() {
      const login = this.options.user
      if (!login || !/^[a-z_]+$/.test(login)) throw new Error('Test database: unknown login')
      const client = {
        inTransaction: false,
        async query(input: string | { text: string; values?: unknown[] }, values?: unknown[]) {
          const text = typeof input === 'string' ? input : input.text
          const params = typeof input === 'string' ? values : input.values
          const db = database()
          await take(client)
          try {
            if (!client.inTransaction) await db.exec(`SET ROLE ${login}`)
            if (/^\s*BEGIN\b/i.test(text)) client.inTransaction = true
            let result: Result | Result[]
            if (params?.length) {
              const r = await db.query(text, params, { parsers: PARSERS })
              result = { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }
            } else {
              const all = (await db.exec(text, { parsers: PARSERS })).map((r) => ({
                rows: r.rows,
                rowCount: r.affectedRows ?? r.rows.length,
              })) as Result[]
              // node-postgres names each statement's command; callers check the final COMMIT.
              if (/\bCOMMIT\s*;?\s*$/i.test(text)) all[all.length - 1].command = 'COMMIT'
              result = all.length === 1 ? all[0] : all
            }
            if (/\b(COMMIT|ROLLBACK)\s*;?\s*$/i.test(text)) client.inTransaction = false
            return result
          } finally {
            if (!client.inTransaction) {
              // Leave the session as the test's own superuser between connections.
              await db.exec('RESET ROLE').catch(() => {})
              give(client)
            }
          }
        },
        async release() {
          if (!client.inTransaction) return
          client.inTransaction = false
          await database()
            .exec('ROLLBACK;RESET ROLE')
            .catch(() => {})
          give(client)
        },
      }
      return client
    }
  }
  return { ...actual, default: { ...actual.default, Pool }, Pool }
}

export type Caller = {
  username: string
  /** Snowflake application roles in the caller's session. */
  roles: Array<'viewer' | 'admin' | 'admin_readonly' | 'app_owner' | 'access_manager'>
}
export const APP_ORIGIN = 'https://gallery.example'

/**
 * Headers of a request from `caller`, as the platform delivers them after sign-in, or of a
 * request with no session when `caller` is null. Each call uses a new session token, so
 * the role answer cached for one test's caller is never reused by another.
 */
export function callerHeaders(caller: Caller | null): Headers {
  const headers = new Headers({ origin: APP_ORIGIN, host: new URL(APP_ORIGIN).host })
  if (caller) {
    headers.set('sf-context-current-user', caller.username)
    headers.set('sf-context-current-user-token', `test-session-${randomUUID()}`)
  }
  return headers
}

/** The provider's answer to the role question `lib/identity/auth.ts` asks about the caller. */
export function snowflakeRoleRows(caller: Caller | null) {
  const has = (role: Caller['roles'][number]) => caller?.roles.includes(role) === true
  return [
    {
      IS_APP_OWNER: has('app_owner'),
      IS_ADMIN: has('admin'),
      IS_ADMIN_READONLY: has('admin_readonly'),
      IS_VIEWER: has('viewer'),
      CAN_MANAGE_ACCESS: has('access_manager'),
    },
  ]
}
