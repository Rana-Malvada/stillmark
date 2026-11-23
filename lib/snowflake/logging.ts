const LOG_PREFIX = '[snowflake]'

/** Single-line SQL preview for logs (keeps log volume small). */
export function previewSql(sql: string, maxLen = 200): string {
  if (/\bPASSWORD\s*=/i.test(sql)) return '[Password statement redacted]'
  const s = sql.replace(/\s+/g, ' ').trim()
  if (s.length <= maxLen) return s
  return `${s.slice(0, maxLen)}…`
}

function sfLogQuiet(): boolean {
  const v = process.env.SNOWFLAKE_SDK_QUIET
  return v === '1' || v === 'true'
}

export function sfLog(message: string): void {
  if (sfLogQuiet()) return
  console.log(`${LOG_PREFIX} ${message}`)
}
