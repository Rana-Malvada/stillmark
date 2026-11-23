function limit(name: string, fallback: number, maximum: number) {
  const value = process.env[name]
  if (value === undefined) return fallback
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}`)
  return Number(value)
}
/** Limits are per process; caller pool max is per exact credential context. */
export function snowflakePoolConfig() {
  return { min: 0, max: limit('SF_POOL_MAX', 10, 100) }
}
export function snowflakeStoragePoolConfig() {
  return {
    min: 0,
    max: limit('SF_STORAGE_POOL_MAX', snowflakePoolConfig().max, 100),
    acquireTimeoutMillis: limit('SF_STORAGE_CHECKOUT_TIMEOUT_MS', 10000, 120000),
    maxWaitingClients: limit('SF_STORAGE_MAX_PENDING_CHECKOUTS', 128, 4096),
  }
}
export function signedUrlCacheConfig() {
  return {
    maxEntries: limit('MEDIA_URL_CACHE_MAX_ENTRIES', 4096, 100000),
    maxBytes: limit('MEDIA_URL_CACHE_MAX_BYTES', 16 * 1024 ** 2, 256 * 1024 ** 2),
  }
}
export function snowflakeCallerRetention() {
  return {
    idleMs: limit('SF_CALLER_POOL_IDLE_MS', 120000, 3600000),
    maxIdle: limit('SF_CALLER_POOL_MAX_IDLE', 512, 10000),
  }
}

export function nativeRoleCacheMaxEntries() {
  return limit('NATIVE_ROLE_CACHE_MAX_ENTRIES', 4096, 100000)
}

export function gatewayRoleCacheMaxEntries() {
  return limit('GATEWAY_ROLE_CACHE_MAX_ENTRIES', 4096, 100000)
}

export function gatewayRoleRefreshMax() {
  return limit(
    'GATEWAY_ROLE_REFRESH_MAX',
    Math.max(1, Math.floor(snowflakePoolConfig().max / 2)),
    50,
  )
}
