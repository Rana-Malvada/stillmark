/**
 * Every feature switch the application reads, in one place. A switch is an
 * environment variable set in the deployment profile and rendered into `app.yml`
 * (see docs/DEPLOYMENT-CONFIGURATION.md). Naming a switch that is not listed here is
 * a compile error, so a typo cannot silently read as "off".
 *
 * Switches are read on each call, not cached, so a test can change one at run time.
 */
export type FlagName =
  | 'AUTH0_MANAGEMENT_ENABLED'
  | 'AUTOMATIC_MEDIA_PROCESSING_ENABLED'
  | 'BACKGROUND_JOBS_ENABLED'
  | 'CUSTOMER_ACCOUNTS_ENABLED'
  | 'GATEWAY_AUTH_ENABLED'
  | 'MEDIA_GRANTS_ENABLED'
  | 'MEDIA_SIGNING_BATCH_ENABLED'
  | 'PG_BATCH_TRANSACTION_START_ENABLED'
  | 'PG_JSON_PAGE_ROWS_ENABLED'
  | 'PG_MEDIA_LOOKUP_FUNCTION_ENABLED'
  | 'PREVIEW_BATCH_ENABLED'
  | 'SEARCH_BATCH_RANKING_ENABLED'
  | 'SEARCH_VISUAL_ENABLED'
  | 'STORAGE_BYTE_REUSE_ENABLED'
  | 'TRAVEL_SUMMARIES_ENABLED'
  | 'UPLOAD_PROCESSING_QUEUE_ENABLED'
  | 'UPLOAD_PROCESSING_WORKER_ENABLED'
  | 'UPLOAD_QUEUE_METRICS_ENABLED'
  | 'VIDEO_CONVERSION_ENABLED'
  | 'VIDEO_STREAMING_ENABLED'

/** On only when the variable is exactly `true`; unset means off. */
export function flagOn(name: FlagName): boolean {
  return process.env[name] === 'true'
}

/** On unless the variable is exactly `false`; unset means on. */
export function flagNotOff(name: FlagName): boolean {
  return process.env[name] !== 'false'
}
