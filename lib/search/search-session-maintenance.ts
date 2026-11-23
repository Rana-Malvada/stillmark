/** RLS scopes foreground pruning to the current viewer. Keep deletions bounded;
 * repeated requests/maintenance passes drain any backlog without a long delete. */
export const pruneViewerSearchSessionsSql = `DELETE FROM search_sessions WHERE id IN (
  SELECT id FROM search_sessions WHERE expires_at<=now() ORDER BY expires_at,id LIMIT 50
) OR id IN (
  SELECT id FROM search_sessions ORDER BY last_used_at DESC,id DESC OFFSET 50 LIMIT 50
)`
export const pruneExpiredSearchSessionsSql = `WITH expired AS (
  SELECT id FROM search_sessions WHERE expires_at<=now()
  ORDER BY expires_at,id LIMIT 500 FOR UPDATE SKIP LOCKED
) DELETE FROM search_sessions s USING expired e WHERE s.id=e.id`
/** Approximate popularity, at most one write per minute for a frequently reused
 * session. Never used as an access decision or billing counter. */
export function shouldTouchSearchSession(lastUsed: string | Date, now = Date.now()) {
  const last = new Date(lastUsed).getTime()
  return !Number.isFinite(last) || now - last >= 60000
}
