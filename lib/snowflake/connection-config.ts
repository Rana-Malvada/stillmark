// Server-only connection configuration; no pools or query execution.
import fs from 'fs'
import path from 'path'
import os from 'os'
import snowflake from 'snowflake-sdk'

export function baseConfig(): snowflake.ConnectionOptions {
  const application = 'SnowflakeAppRuntime'
  const base: snowflake.ConnectionOptions = { application }
  if (process.env.SNOWFLAKE_ACCOUNT) base.account = process.env.SNOWFLAKE_ACCOUNT
  if (process.env.SNOWFLAKE_WAREHOUSE) base.warehouse = process.env.SNOWFLAKE_WAREHOUSE
  if (process.env.SNOWFLAKE_ACCOUNT_URL) base.accessUrl = process.env.SNOWFLAKE_ACCOUNT_URL
  // SNOWFLAKE_HOST is commonly injected by eval/CI frameworks
  if (!base.accessUrl && process.env.SNOWFLAKE_HOST) {
    base.accessUrl = `https://${process.env.SNOWFLAKE_HOST}`
  }
  if (process.env.SNOWFLAKE_ROLE) base.role = process.env.SNOWFLAKE_ROLE
  if (process.env.SNOWFLAKE_DATABASE) base.database = process.env.SNOWFLAKE_DATABASE
  if (process.env.SNOWFLAKE_SCHEMA) base.schema = process.env.SNOWFLAKE_SCHEMA
  return base
}

// --- ~/.snowflake/connections.toml + config.toml reader ---

export interface TomlConnection {
  account?: string
  user?: string
  password?: string
  host?: string
  port?: string | number
  warehouse?: string
  database?: string
  schema?: string
  region?: string
  role?: string
  authenticator?: string
  protocol?: string
  token_file_path?: string
  [key: string]: unknown
}

let _tomlConfigCache:
  { defaultName: string; connections: Record<string, TomlConnection> } | null | undefined

function normalizeConnectionsToml(doc: Record<string, any>): Record<string, TomlConnection> {
  const result: Record<string, TomlConnection> = {}
  for (const [key, val] of Object.entries(doc)) {
    if (key === 'default_connection_name' || key === 'connections') continue
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      result[key] = val as TomlConnection
    }
  }
  if (
    typeof doc.connections === 'object' &&
    doc.connections !== null &&
    !Array.isArray(doc.connections)
  ) {
    Object.assign(result, doc.connections as Record<string, TomlConnection>)
  }
  return result
}

/**
 * Resolve a Snowflake connection from local TOML config files.
 *
 * Tries two file layouts (in order):
 *   1. ~/.snowflake/connections.toml — supports both nested ([connections.name])
 *      and legacy (top-level [name]) formats; nested wins on conflict.
 *   2. ~/.snowflake/config.toml — connections nested under [connections.*] sections.
 *
 * Both files may contain a `default_connection_name` key. The env var
 * SNOWFLAKE_CONNECTION_NAME takes priority, then SNOWFLAKE_DEFAULT_CONNECTION_NAME
 * (set by Cortex Code for SnowCLI compatibility), then the file-level default.
 *
 * Result is cached for the lifetime of the process.
 */
export function readTomlDefaultConnection(): TomlConnection | null {
  if (_tomlConfigCache === undefined) {
    _tomlConfigCache = null // mark as attempted
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { parse } = require('smol-toml') as { parse: (s: string) => Record<string, any> }
      const snowDir = process.env.SNOWFLAKE_HOME ?? path.join(os.homedir(), '.snowflake')

      let defaultName = ''
      let connections: Record<string, TomlConnection> = {}

      // connections.toml: top-level sections are connections
      const connPath = path.join(snowDir, 'connections.toml')
      if (fs.existsSync(connPath)) {
        const doc = parse(fs.readFileSync(connPath, 'utf8'))
        if (typeof doc.default_connection_name === 'string')
          defaultName = doc.default_connection_name
        connections = normalizeConnectionsToml(doc)
      }

      // config.toml: connections nested under [connections.*], also has default_connection_name
      const configPath = path.join(snowDir, 'config.toml')
      if (fs.existsSync(configPath)) {
        const doc = parse(fs.readFileSync(configPath, 'utf8'))
        if (!defaultName && typeof doc.default_connection_name === 'string') {
          defaultName = doc.default_connection_name
        }
        // Only use config.toml connections if connections.toml had none
        if (Object.keys(connections).length === 0) {
          connections = (doc.connections ?? {}) as Record<string, TomlConnection>
        }
      }

      // General SNOWFLAKE_<KEY> env vars overlay on every toml connection (spec §3.B)
      const envOverlay: Partial<TomlConnection> = {}
      const CONN_KEYS = new Set([
        'account',
        'user',
        'password',
        'database',
        'schema',
        'role',
        'warehouse',
        'protocol',
        'host',
        'port',
        'region',
        'authenticator',
      ])
      for (const [k, v] of Object.entries(process.env)) {
        if (
          !k.startsWith('SNOWFLAKE_') ||
          k === 'SNOWFLAKE_CONNECTION_NAME' ||
          k === 'SNOWFLAKE_DEFAULT_CONNECTION_NAME' ||
          k === 'SNOWFLAKE_HOME'
        )
          continue
        const field = k.slice('SNOWFLAKE_'.length).toLowerCase()
        if (CONN_KEYS.has(field)) (envOverlay as Record<string, string>)[field] = v!
      }
      if (Object.keys(envOverlay).length > 0) {
        for (const name of Object.keys(connections)) {
          connections[name] = { ...connections[name], ...envOverlay }
        }
      }

      // SNOWFLAKE_CONNECTION_NAME overrides file-level default
      if (process.env.SNOWFLAKE_CONNECTION_NAME) {
        defaultName = process.env.SNOWFLAKE_CONNECTION_NAME
      } else if (process.env.SNOWFLAKE_DEFAULT_CONNECTION_NAME) {
        defaultName = process.env.SNOWFLAKE_DEFAULT_CONNECTION_NAME
      }

      _tomlConfigCache = { defaultName, connections }
    } catch {
      // parse error or smol-toml not installed — silently skip
      return null
    }
  }

  if (!_tomlConfigCache) return null

  const { defaultName, connections } = _tomlConfigCache
  const names = Object.keys(connections)
  if (names.length === 0 && !defaultName) return null

  if (defaultName) {
    const connection = connections[defaultName]
    if (!connection)
      throw new Error('Configured Snowflake connection was not found; refusing fallback.')
    return connection
  }
  return connections[names[0]] ?? null
}

/** Reset the connection config cache. Exported for testing only. */
export function resetTomlConfigCache() {
  _tomlConfigCache = undefined
}

export function tomlConnectionConfig(conn: TomlConnection): snowflake.ConnectionOptions {
  // Use SDK's normalizeConnectionOptions for snake_case -> camelCase + key aliases
  // Type assertion needed until @types/snowflake-sdk includes normalizeConnectionOptions
  const normalize = (
    snowflake as unknown as {
      normalizeConnectionOptions: (o: Record<string, unknown>) => snowflake.ConnectionOptions
    }
  ).normalizeConnectionOptions
  const normalized = normalize(conn as Record<string, unknown>)
  // SDK doesn't handle host/port/protocol -> accessUrl, so we do it here
  if (conn.host && !normalized.accessUrl) {
    const protocol = conn.protocol ?? 'https'
    const port = conn.port ? `:${conn.port}` : ''
    normalized.accessUrl = `${protocol}://${conn.host}${port}`
  }
  // The SDK only reads token_file_path when it loads the TOML itself
  // (createConnection with no options). Because we build the options object and
  // pass it to createConnection/createPool, the SDK ignores token_file_path and
  // sends an empty OAuth token, which the server rejects with error 390303.
  // So read the token file ourselves for plain "oauth" auth.
  if (
    !normalized.token &&
    typeof normalized.authenticator === 'string' &&
    normalized.authenticator.toUpperCase() === 'OAUTH' &&
    conn.token_file_path
  ) {
    normalized.token = fs.readFileSync(conn.token_file_path, 'utf8').trim()
  }
  return normalized
}
