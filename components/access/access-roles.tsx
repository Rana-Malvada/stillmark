import { Plus, ShieldCheck } from 'lucide-react'
import type { Overview } from '@/lib/identity/access-response'
import type { AccessRoleForm } from './use-access-editor'
import { input } from './access-presentation'

interface Props {
  data: Overview | null
  canManageAccess: boolean
  busy: boolean
  loading: boolean
  form: AccessRoleForm
}
export function AccessRoles({ data, canManageAccess, busy, loading, form }: Props) {
  const { roleName, setRoleName, roleLabel, setRoleLabel, profile, setProfile, createRole } = form
  return (
    <>
      {!data?.customerAccountsEnabled && (
        <form onSubmit={createRole} className="surface-panel p-5 sm:p-6 space-y-4">
          <h2 className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="w-4 h-4 text-primary" />
            Create a gallery role
          </h2>
          <div className="grid sm:grid-cols-3 gap-4">
            <label className="text-sm space-y-2">
              <span>Role identifier</span>
              <input
                disabled={!canManageAccess}
                className={input}
                required
                maxLength={70}
                pattern="[A-Za-z][A-Za-z0-9_]*"
                value={roleName}
                onChange={(e) => setRoleName(e.target.value)}
                placeholder="FAMILY"
              />
            </label>
            <label className="text-sm space-y-2">
              <span>Display name</span>
              <input
                disabled={!canManageAccess}
                className={input}
                required
                maxLength={100}
                value={roleLabel}
                onChange={(e) => setRoleLabel(e.target.value)}
                placeholder="Family"
              />
            </label>
            <label className="text-sm space-y-2">
              <span>Permissions</span>
              <select
                disabled={!canManageAccess}
                className={input}
                value={profile}
                onChange={(e) =>
                  setProfile(e.target.value as 'viewer' | 'admin' | 'admin_readonly')
                }
              >
                <option value="viewer">Viewer — browse and manage personal albums</option>
                <option value="admin">Admin — manage photos and albums</option>
                <option value="admin_readonly">
                  Read-only admin — view admin pages and controls
                </option>
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground break-all">
            {data?.permissionAuthority === 'postgres' ? 'App role' : 'Snowflake role'}:
            PERSONAL_PHOTOS_GROUP_{roleName.toUpperCase() || 'FAMILY'}. Permissions combine across
            assigned roles. Album ownership controls editing. The built-in App Owner role includes
            all gallery and access-management permissions.
          </p>
          <button className="primary-button" disabled={!canManageAccess || busy || loading}>
            <Plus className="w-4 h-4" />
            Create role
          </button>
        </form>
      )}
      <div className="grid sm:grid-cols-2 gap-4">
        {data?.roles.map((role) => (
          <section className="surface-panel p-5" key={role.name}>
            <h2 className="font-semibold">{role.display_name}</h2>
            <p className="text-xs text-muted-foreground break-all mt-2">{role.name}</p>
            <p className="text-sm mt-4">
              {role.profile === 'app_owner'
                ? 'Admin · full access to all albums, users, search sync and maintenance'
                : role.profile === 'admin'
                  ? 'Admin · upload, edit and delete gallery content'
                  : role.profile === 'admin_readonly'
                    ? 'Read-only admin · inspect admin pages; add Viewer for personal albums'
                    : 'Member · manage personal albums and view albums shared with you'}
            </p>
            {role.state !== 'ready' && (
              <p className="text-sm text-destructive mt-2">
                Setup incomplete — retry the operation in Audit history.
              </p>
            )}
          </section>
        ))}
      </div>
    </>
  )
}
