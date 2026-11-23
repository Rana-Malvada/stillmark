/** Only the actual route-bound GET can request a same-statement media lookup. */
export function gatewayMediaPath(binding?: { method: string; target: string }): string | null {
  if (binding?.method !== 'GET') return null
  const url = new URL(binding.target, 'https://request.invalid')
  if (url.pathname !== '/api/images') return null
  const path = url.searchParams.get('path')
  if (!path || path.length > 1024 || !/^(originals|display|thumbnails)\//.test(path)) return null
  return path
}

// Both existing functions retain their security and replay checks. CASE prevents
// a catalog lookup for disabled, revoked, unlinked or unprivileged identities.
// The media function sets RLS identity locally to this implicit transaction.
export const gatewayMediaBootstrapSql = `SELECT identity.*,
 CASE WHEN NOT identity.revoked AND identity.enabled
   AND identity.app_role IN ('viewer','admin','admin_readonly')
 THEN photo_security.lookup_media($5::text,jsonb_build_object(
   'username',identity.name,
   'mainAdmin',coalesce((identity.app_owner OR identity.main_admin)
      AND identity.app_role<>'admin_readonly',false),
   'adminRead',identity.app_role<>'viewer'))
 ELSE NULL END AS prefetched_media
 FROM photo_security.gateway_app_identity_once($1,$2::uuid,$3::uuid,$4) identity`
