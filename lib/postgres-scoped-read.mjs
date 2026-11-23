import pg from 'pg'
// Internal SQL only, with scalar parameters serialized by node-postgres's escaping.
// Simple protocol sends BEGIN/identity/SELECT/COMMIT in one network exchange.
// RLS still runs as the NOLOGIN/NOBYPASSRLS reader. No SECURITY DEFINER is introduced.
function valueSql(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && !value.includes('\0') && value.length <= 65536)
    return pg.escapeLiteral(value)
  throw Error('Unsupported scoped read parameter')
}
export function scopedReadStatement(sql, params, identity, disableJit = false) {
  if (
    !/^(SELECT|WITH)\b/i.test(sql.trim()) ||
    sql.length > 131072 ||
    sql.includes(';') ||
    sql.includes('--') ||
    sql.includes('/*') ||
    !identity.username ||
    typeof identity.mainAdmin !== 'boolean'
  )
    throw Error('Invalid scoped read statement')
  // Match quoted SQL before placeholders; replacement values are never rescanned.
  const query = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\$[0-9]+/g, (token) => {
    if (!token.startsWith('$')) return token
    const n = Number(token.slice(1))
    if (!Number.isSafeInteger(n) || n < 1 || n > params.length)
      throw Error('Missing scoped read parameter')
    return valueSql(params[n - 1])
  })
  return (
    'BEGIN READ ONLY; SET LOCAL ROLE personal_photos_reader;' +
    (disableJit ? ' SET LOCAL jit=off;' : '') +
    ` SELECT set_config('photos.username',${valueSql(identity.username)},true),set_config('photos.main_admin','${identity.mainAdmin ? 'true' : 'false'}',true);` +
    query +
    '; COMMIT;'
  )
}
