// Server-only secret resolution, independent of query pools.
import fs from 'fs'
import path from 'path'

// --- Secrets ---

/**
 * Snowflake secret types supported by {@link getSecret}. Mirrors the `TYPE` of a
 * Snowflake `SECRET` object. (`GENERIC_STRING`, `PASSWORD`, and `OAUTH2` are supported.)
 */
export enum SecretType {
  /** Single opaque string (e.g. an API key). `getSecret` returns the string. */
  GENERIC_STRING = 'GENERIC_STRING',
  /** Username + password pair. `getSecret` returns `{ username, password }`. */
  PASSWORD = 'PASSWORD',
  /** OAuth2 access token. `getSecret` returns a `Promise<string>` — see the docstring. */
  OAUTH2 = 'OAUTH2',
}

/** Value returned for a {@link SecretType.PASSWORD} secret. */
export interface PasswordSecret {
  username: string
  password: string
}

/** Directory where SPCS mounts declared secrets (one subdirectory per secret). */
const SPCS_SECRETS_DIR = '/secrets'

/** `SNOWFLAKE_SECRET_<NAME>_<FIELD>` — the env var the runtime injects (name upper-cased). */
function secretEnvVarName(name: string, field: string): string {
  return `SNOWFLAKE_SECRET_${name.toUpperCase()}_${field}`
}

/** Read a mounted secret file (SPCS) if present and non-empty; otherwise null. */
function readMountedSecretFile(name: string, file: string): string | null {
  const filePath = path.join(SPCS_SECRETS_DIR, name, file)
  try {
    const contents = fs.readFileSync(filePath, 'utf8')
    if (typeof contents === 'string' && contents.trim() !== '') {
      return contents.trim()
    }
  } catch {
    // File not mounted (e.g. local dev).
  }
  return null
}

/**
 * Read one field of a secret.
 *
 * In SPCS the runtime mounts each declared secret as files under
 * `/secrets/<name>/<field>`. We read that file first, and fall back to the
 * `SNOWFLAKE_SECRET_<NAME>_<FIELD>` env var (upper-case) for local development
 * where no files are mounted.
 *
 * @param name  Logical secret name (matches app.yml `secrets[].name`).
 * @param file  Mounted file name (lower-case), e.g. `secret_string`, `username`, `password`.
 * @param env   Env var field suffix (upper-case), e.g. `SECRET_STRING`, `USERNAME`, `PASSWORD`.
 */
function readSecretField(name: string, file: string, env: string): string {
  // 1. Mounted secret file (SPCS): /secrets/<name>/<file>
  const mounted = readMountedSecretFile(name, file)
  if (mounted !== null) return mounted

  // 2. Env var fallback (local dev): SNOWFLAKE_SECRET_<NAME>_<FIELD>
  const envVar = secretEnvVarName(name, env)
  const value = process.env[envVar]
  if (value) return value

  throw new Error(
    `Secret "${name}" field "${file}" is not available. Expected the mounted file ` +
      `${path.join(SPCS_SECRETS_DIR, name, file)} (SPCS) or the env var ${envVar} (local dev). ` +
      `Declare the secret under the top-level "secrets:" block in app.yml (see README → Secrets).`,
  )
}

// --- OAUTH2 tokens ---
//
// In SPCS the runtime mounts an OAUTH2 secret's (auto-rotated) access token at
// /secrets/<name>/access_token, so we read that file fresh on every call. Locally
// there is no mount and the token expires after a few minutes, so the app mints and
// refreshes tokens itself via the OAuth2 client-credentials grant, caching them in
// memory until shortly before they expire.

interface CachedOAuthToken {
  token: string
  /** Epoch ms after which the cached token must be refreshed. */
  expiresAtMs: number
}

/** Refresh a cached token this many ms before it actually expires. */
const OAUTH_REFRESH_MARGIN_MS = 60_000
/** Fallback lifetime (ms) when the token endpoint omits `expires_in`. */
const OAUTH_DEFAULT_TTL_MS = 300_000
const OAUTH_REQUEST_TIMEOUT_MS = 15_000

const oauthTokenCache = new Map<string, CachedOAuthToken>()
// De-dupe concurrent refreshes for the same secret so we mint one token, not N.
const oauthInflight = new Map<string, Promise<string>>()

/** Mint a fresh access token via the OAuth2 client-credentials grant and cache it. */
async function fetchClientCredentialsToken(name: string, tokenUrl: string): Promise<string> {
  const clientId = process.env[secretEnvVarName(name, 'OAUTH_CLIENT_ID')]
  const clientSecret = process.env[secretEnvVarName(name, 'OAUTH_CLIENT_SECRET')]
  const scope = process.env[secretEnvVarName(name, 'OAUTH_SCOPE')]

  const body = new URLSearchParams({ grant_type: 'client_credentials' })
  if (clientId) body.set('client_id', clientId)
  if (clientSecret) body.set('client_secret', clientSecret)
  if (scope) body.set('scope', scope)

  let res: Response
  let json: unknown
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    })
    if (res.ok) json = await res.json()
    else await res.body?.cancel()
  } catch {
    // Provider bodies and transport errors may include credentials. Never echo them.
    throw new Error(`OAuth2 secret "${name}": token request failed or timed out.`)
  }
  if (!res.ok) {
    throw new Error(`OAuth2 secret "${name}": token endpoint returned HTTP ${res.status}.`)
  }
  if (!json || typeof json !== 'object') {
    throw new Error(`OAuth2 secret "${name}": invalid token response.`)
  }
  const { access_token: token, expires_in: expiresIn } = json as Record<string, unknown>
  if (
    typeof token !== 'string' ||
    !token.trim() ||
    (expiresIn !== undefined &&
      (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0))
  )
    throw new Error(`OAuth2 secret "${name}": invalid token response.`)
  const ttlMs = typeof expiresIn === 'number' ? expiresIn * 1000 : OAUTH_DEFAULT_TTL_MS
  oauthTokenCache.set(name, { token, expiresAtMs: Date.now() + ttlMs })
  return token
}

/** Local-dev OAuth token: cached client-credentials token (auto-refreshed) or a static env token. */
async function getLocalOAuthToken(name: string): Promise<string> {
  const cached = oauthTokenCache.get(name)
  if (cached && Date.now() < cached.expiresAtMs - OAUTH_REFRESH_MARGIN_MS) {
    return cached.token
  }

  const tokenUrl = process.env[secretEnvVarName(name, 'OAUTH_TOKEN_URL')]
  if (tokenUrl) {
    // De-dupe concurrent refreshes so a burst of requests mints a single token.
    let inflight = oauthInflight.get(name)
    if (!inflight) {
      inflight = fetchClientCredentialsToken(name, tokenUrl).finally(() =>
        oauthInflight.delete(name),
      )
      oauthInflight.set(name, inflight)
    }
    return inflight
  }

  // Escape hatch for quick local testing: a static token (NOT auto-refreshed — it will expire).
  const staticToken = process.env[secretEnvVarName(name, 'ACCESS_TOKEN')]
  if (staticToken) return staticToken

  throw new Error(
    `OAuth2 secret "${name}" is not available locally. Set ` +
      `${secretEnvVarName(name, 'OAUTH_TOKEN_URL')} + ${secretEnvVarName(name, 'OAUTH_CLIENT_ID')} + ` +
      `${secretEnvVarName(name, 'OAUTH_CLIENT_SECRET')} for the client-credentials refresh flow ` +
      `(recommended — auto-refreshes), or ${secretEnvVarName(name, 'ACCESS_TOKEN')} for a short-lived ` +
      `static token (see README → Secrets).`,
  )
}

/** Resolve an OAuth2 access token: SPCS mounted file (auto-rotated) first, else app-level flow. */
async function readOAuth2Token(name: string): Promise<string> {
  const mounted = readMountedSecretFile(name, 'access_token')
  if (mounted !== null) return mounted
  return getLocalOAuthToken(name)
}

/**
 * Read a Snowflake SECRET value at runtime.
 *
 * Use this helper rather than reading `SNOWFLAKE_SECRET_*` env vars yourself or
 * querying the SECRET object directly (e.g. `SYSTEM$GET_SECRET`) — a direct
 * runtime query is insecure and is not supported.
 *
 * The secret must be declared under a `secrets:` block in `app.yml` so the runtime
 * mounts it. `secrets:` is a TOP-LEVEL key (a sibling of `install:`/`run:`/
 * `profile:`) — do NOT nest it under `run:`, or it is ignored:
 *
 *   secrets:                  # top-level, NOT under run:
 *     - name: API_KEY
 *       secret: db.schema.api_key_secret
 *
 * Resolution (mounted file first, then local-dev fallback):
 *   - GENERIC_STRING → /secrets/<name>/secret_string   | SNOWFLAKE_SECRET_<NAME>_SECRET_STRING
 *   - PASSWORD       → /secrets/<name>/username         | SNOWFLAKE_SECRET_<NAME>_USERNAME
 *                      /secrets/<name>/password         | SNOWFLAKE_SECRET_<NAME>_PASSWORD
 *   - OAUTH2 (async) → /secrets/<name>/access_token in SPCS (mounted, auto-rotated). Locally the
 *                      app mints + refreshes tokens via the OAuth2 client-credentials grant using
 *                      SNOWFLAKE_SECRET_<NAME>_OAUTH_TOKEN_URL / _OAUTH_CLIENT_ID / _OAUTH_CLIENT_SECRET
 *                      (+ optional _OAUTH_SCOPE), caching until just before expiry. `getSecret`
 *                      returns a `Promise<string>` for OAUTH2 — `await` it.
 *
 * @example
 *   const apiKey = getSecret("API_KEY", SecretType.GENERIC_STRING)
 *   const { username, password } = getSecret("DB_CREDS", SecretType.PASSWORD)
 *   const token = await getSecret("MY_OAUTH", SecretType.OAUTH2)
 */
export function getSecret(name: string, type: SecretType.GENERIC_STRING): string
export function getSecret(name: string, type: SecretType.PASSWORD): PasswordSecret
export function getSecret(name: string, type: SecretType.OAUTH2): Promise<string>
export function getSecret(name: string, type: SecretType): string | PasswordSecret | Promise<string>
export function getSecret(
  name: string,
  type: SecretType,
): string | PasswordSecret | Promise<string> {
  switch (type) {
    case SecretType.GENERIC_STRING:
      return readSecretField(name, 'secret_string', 'SECRET_STRING')
    case SecretType.PASSWORD:
      return {
        username: readSecretField(name, 'username', 'USERNAME'),
        password: readSecretField(name, 'password', 'PASSWORD'),
      }
    case SecretType.OAUTH2:
      return readOAuth2Token(name)
    default:
      throw new Error(`Unsupported secret type: ${String(type)}`)
  }
}
