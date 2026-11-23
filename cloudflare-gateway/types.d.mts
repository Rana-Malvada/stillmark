// Ambient types for the gateway Worker, used only by `npm run typecheck`.
// Nothing here is bundled or executed. This file deliberately has no imports or
// exports so that its declarations are global to the gateway modules, and it is
// named `.d.mts` so the application's own type check (`**/*.ts`) does not load it.

// ---------------------------------------------------------------------------
// Cloudflare runtime surface. Only the members the gateway calls are declared;
// web-standard globals come from TypeScript's `webworker` library.
// ---------------------------------------------------------------------------

interface CacheStorage {
  /** The Workers default cache. */
  readonly default: Cache
}

interface DurableObjectId {
  toString(): string
}

interface DurableObjectStub {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

interface DurableObjectListOptions {
  prefix?: string
  limit?: number
}

/** Stored values are untyped at rest; callers state the shape they expect. */
interface DurableObjectTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>>
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number): Promise<void>
}

interface DurableObjectStorage extends DurableObjectTransaction {
  deleteAll(): Promise<void>
  transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage
  waitUntil(promise: Promise<unknown>): void
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

interface ScheduledController {
  readonly cron: string
  readonly scheduledTime: number
}

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

interface AnalyticsEngineDataset {
  writeDataPoint(event: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void
}

interface AssetsBinding {
  fetch(request: Request): Promise<Response>
}

declare module 'cloudflare:sockets' {
  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>
    readonly writable: WritableStream<Uint8Array>
    readonly opened: Promise<unknown>
    readonly closed: Promise<void>
    close(): Promise<void>
    startTls(): Socket
  }
  export function connect(
    address: string | { hostname: string; port: number },
    options?: { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean },
  ): Socket
}

// ---------------------------------------------------------------------------
// Worker environment
// ---------------------------------------------------------------------------

/**
 * Everything the Worker reads from `env`.
 *
 * Variables and bindings declared in `wrangler.jsonc` are required. Secrets and
 * optional tuning values are managed outside Git and may be absent, so they are
 * optional here and every read must either validate the value or fail closed.
 */
interface Env {
  // --- vars (wrangler.jsonc) ---
  GATEWAY_ORIGIN: string
  CUSTOMER_ACCOUNTS_ENABLED: string
  PUBLIC_SIGNUP_ENABLED: string
  AUTH0_DOMAIN: string
  AUTH0_CLIENT_ID: string
  AUTH0_LOG_POLL_ENABLED: string
  AUTH0_LOG_TENANT_DOMAIN: string
  GALLERY_ENABLED: string
  UPLOAD_SERVICE_ENABLED: string
  UPLOAD_SERVICE_DYNAMIC: string
  UPLOAD_SERVICE_CANARY: string
  UPLOAD_SERVICE_ORIGIN: string
  PREVIEW_BATCH_ENABLED: string
  /** 'enabled', 'canary', or anything else for off. */
  MEDIA_DELIVERY_MODE: string
  MEDIA_GRANTS_ENABLED: string
  MEDIA_GRANT_CACHE_ENABLED: string
  /** 'postgres', or anything else for the Durable Object backend. */
  SESSION_REVOCATION_BACKEND: string
  PG_STORAGE_WARNING_BYTES: string
  GATEWAY_DIAGNOSTICS: string

  // --- bindings (wrangler.jsonc) ---
  /** Static assets (`assets.binding`). */
  BRANDING_ASSETS: AssetsBinding
  /** `ratelimits` */
  AUTH_RATE_LIMIT: RateLimit
  SHARE_RATE_LIMIT: RateLimit
  /** `durable_objects`: GatewayTokenStore, RevokedSession, EmailAlerts. */
  GATEWAY_TOKENS: DurableObjectNamespace
  REVOKED_SESSIONS: DurableObjectNamespace
  EMAIL_ALERTS: DurableObjectNamespace
  /** `analytics_engine_datasets` */
  GATEWAY_METRICS: AnalyticsEngineDataset

  // --- secrets (not in wrangler.jsonc) ---
  /** Private application origin, `https://<name>.snowflakecomputing.app`. */
  SNOWFLAKE_ORIGIN?: string
  /** Bootstrap ingress credential; the rotated one lives in GatewayTokenStore. */
  SNOWFLAKE_PAT?: string
  /** 64 hex characters. Encrypts session and login-flow cookies and stored tokens. */
  SESSION_KEY?: string
  /** 64 hex characters. Signs identity assertions and monitor requests. */
  GATEWAY_SIGNING_KEY?: string
  MEDIA_GRANT_SIGNING_KEY?: string
  AUTH0_CLIENT_SECRET?: string
  /** 64 hex characters. Verifies the Auth0 Action's credential-change events. */
  AUTH0_EVENT_KEY?: string
  /** 64 hex characters. Bearer token for the Auth0 log stream. */
  AUTH0_LOG_STREAM_TOKEN?: string
  AUTH0_LOG_CLIENT_ID?: string
  AUTH0_LOG_CLIENT_SECRET?: string
  /** PKCS#8 PEM used to sign Snowflake key-pair JWTs for token renewal. */
  SNOWFLAKE_RENEWAL_PRIVATE_KEY?: string
  SNOWFLAKE_RENEWAL_KEY_FP?: string
  ICLOUD_SMTP_PASSWORD?: string
  ALERT_SMTP_USERNAME?: string
  ALERT_FROM?: string
  ALERT_TO?: string

  // --- optional tuning, unset in production ---
  MEDIA_EDGE_TIMEOUT_MS?: string
  MEDIA_SIGNED_URL_CACHE_MAX?: string
  /** Isolated load tests only. */
  LOAD_TEST_TRANSPORT_TRACE?: string
}

// ---------------------------------------------------------------------------
// Shapes shared between gateway modules
// ---------------------------------------------------------------------------

/** `fetch`, or a stand-in for it, called with an absolute URL. */
type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>

/** Account details forwarded once, when an account is first created. */
interface Onboarding {
  issuer: string | undefined
  email: string
  displayName: string
  verified: boolean
}

/**
 * The signed-in identity the gateway asserts to the application. Decrypted
 * session cookies also carry the JWT `iat` and `exp`; sessions built inside the
 * gateway for its own calls do not.
 */
interface Session {
  auth0Subject: string
  sid: string
  /** Missing only on cookies issued before fixed session ceilings existed. */
  startedAt?: number
  absoluteExpiresAt?: number
  remember?: boolean
  revocationBackend?: string
  iat?: number
  exp?: number
  onboarding?: Onboarding
  credentialChange?: number
}

/** Contents of the short-lived login-flow cookie. */
interface LoginFlow {
  state: string
  nonce: string
  verifier: string
  challenge: string
  signup: boolean
  remember: boolean
}

/** A successful password change, as reported by Auth0. */
interface CredentialEvent {
  issuer: string
  subject: string
  /** Unix seconds. */
  changedAt: number
}

/** Result of one attempt to send an operational email. */
type AlertDelivery = { accepted: true } | { accepted: false; stage: string; error: string }
