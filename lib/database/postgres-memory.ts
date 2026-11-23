/** Per-process query memory budget; unset preserves the database's configured default. */
export function postgresAppMemoryOptions(
  value = process.env.PG_APP_WORK_MEM_KB,
): string | undefined {
  if (value === undefined) return undefined
  if (!/^[0-9]+$/.test(value) || Number(value) < 64 || Number(value) > 1_048_576)
    throw new Error('PG_APP_WORK_MEM_KB must be an integer between 64 and 1048576')
  // Only a validated number enters the startup options. This is per sort/hash operation,
  // not a total connection limit; hash_mem_multiplier still applies.
  return `-c work_mem=${Number(value)}`
}
