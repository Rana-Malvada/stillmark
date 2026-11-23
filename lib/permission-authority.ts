/** Temporary migration switch. Invalid configuration never falls back. */
export function postgresPermissionsEnabled(): boolean {
  const authority = process.env.APP_PERMISSION_AUTHORITY ?? 'snowflake'
  if (authority !== 'snowflake' && authority !== 'postgres')
    throw new Error('Invalid APP_PERMISSION_AUTHORITY')
  return authority === 'postgres'
}
