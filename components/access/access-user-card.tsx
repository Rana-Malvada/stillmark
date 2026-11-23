'use client'
import { X } from 'lucide-react'
import { accountLabel, vanityName } from '@/lib/identity/account-presentation'
import type { Overview, User } from '@/lib/identity/access-response'
import type { AccessRequest } from '@/lib/access-management'
import type { AccessController } from './use-access-controller'
import { AllowanceForm } from './allowance-form'

interface Props {
  user: User
  data: Pick<Overview, 'auth0Enabled' | 'customerAccountsEnabled' | 'permissionAuthority' | 'roles'>
  username: string | null
  canManageAccess: boolean
  controller: Pick<AccessController, 'busy' | 'execute' | 'setError' | 'updateAllowance'>
  onResume: (operation: { id: string; request: AccessRequest }) => void
  onDelete: (user: User) => void
  passwordEditor: {
    name: string
    value: string
    open: (name: string) => void
    change: (value: string) => void
    close: () => void
  }
  selectedRole: string
  onSelectRole: (role: string) => void
}
export function AccessUserCard({
  user,
  data,
  username,
  canManageAccess,
  controller,
  onResume,
  onDelete,
  passwordEditor,
  selectedRole,
  onSelectRole,
}: Props) {
  const { busy, execute, setError, updateAllowance } = controller
  const readyRoles = data.roles.filter((role) => role.state === 'ready')
  const input = 'control w-full !text-sm'
  return (
    <section className="surface-panel p-5 space-y-4">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="font-semibold">{vanityName(user)}</h2>
          <p className="text-xs text-muted-foreground mt-1 break-all">
            {user.email || 'Email not available'}
          </p>
          {data?.auth0Enabled && (
            <p className="text-xs text-muted-foreground mt-1">
              {user.auth0_user_id
                ? 'Auth0 login connected'
                : user.state === 'pending'
                  ? 'Login setup unfinished — use Resume setup.'
                  : 'Auth0 login not connected — use Enable login to create it.'}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {data.permissionAuthority === 'postgres' && (
            <button
              className="control"
              disabled={!canManageAccess || busy || !!user.issue || user.name === username}
              onClick={() =>
                void execute({
                  action: 'setUserEnabled',
                  name: user.name,
                  enabled: !user.enabled,
                })
              }
            >
              {user.enabled ? 'Disable app access' : 'Enable app access'}
            </button>
          )}
          {!data?.customerAccountsEnabled && user.recovery?.actor === username && (
            <button
              className="control"
              disabled={!canManageAccess || busy}
              onClick={() => {
                onResume({ id: user.recovery!.id, request: user.recovery!.request })
              }}
            >
              Resume setup
            </button>
          )}
          {!data?.customerAccountsEnabled && (
            <button
              className="control"
              disabled={!canManageAccess || busy || !!user.issue}
              onClick={() => {
                passwordEditor.open(user.name)
              }}
            >
              {data?.auth0Enabled && !user.auth0_user_id ? 'Enable login' : 'Set password'}
            </button>
          )}
          {!data?.customerAccountsEnabled && !data?.auth0Enabled && !user.auth0_user_id && (
            <button
              className="control"
              disabled={!canManageAccess || busy || !!user.issue || !user.roles.length}
              onClick={() => void execute({ action: 'setupLink', name: user.name })}
            >
              Generate login link
            </button>
          )}
          <button
            className="control text-destructive"
            disabled={
              !canManageAccess ||
              busy ||
              (!!user.issue && !user.canDelete) ||
              user.name === username
            }
            onClick={() => {
              setError('')
              onDelete(user)
            }}
          >
            Delete user
          </button>
        </div>
      </div>
      {!data?.customerAccountsEnabled && passwordEditor.name === user.name && (
        <form
          className="space-y-3 border border-border rounded-lg p-4"
          onSubmit={(e) => {
            e.preventDefault()
            void execute({
              action: 'setPassword',
              name: user.name,
              password: passwordEditor.value,
            })
          }}
        >
          <label className="block text-sm space-y-2">
            <span>New password for {accountLabel(user)}</span>
            <input
              disabled={!canManageAccess}
              className={input}
              type="password"
              autoComplete="new-password"
              required
              minLength={14}
              maxLength={256}
              value={passwordEditor.value}
              onChange={(e) => passwordEditor.change(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            14–256 characters with uppercase, lowercase and a number.{' '}
            {data?.auth0Enabled || user.auth0_user_id
              ? 'Sets the Auth0 login password. Permissions stay the same.'
              : 'Replaces the Snowflake password. Snowflake MFA policies still apply.'}
          </p>
          <div className="flex gap-2">
            <button className="primary-button" disabled={!canManageAccess || busy}>
              Save password
            </button>
            <button
              type="button"
              className="control"
              disabled={!canManageAccess || busy}
              onClick={() => {
                passwordEditor.close()
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {user.issue && <p className="text-sm text-destructive">{user.issue}</p>}
      <div className="flex flex-wrap gap-2">
        {user.roles.length ? (
          user.roles.map((role) => (
            <span
              className="inline-flex items-center gap-2 border border-border bg-muted rounded-md px-3 py-1 text-xs"
              key={role}
            >
              {readyRoles.find((r) => r.name === role)?.display_name ?? role}
              <button
                aria-label={`Remove ${role} from ${accountLabel(user)}`}
                disabled={!canManageAccess || busy || !!user.issue}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${role} from ${accountLabel(user)}? This may remove gallery access.`,
                    )
                  )
                    void execute({ action: 'revokeRole', name: user.name, role })
                }}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">No gallery roles assigned</p>
        )}
      </div>
      {user.registration_source === 'public' && canManageAccess && (
        <AllowanceForm
          busy={busy}
          onSave={(request) => updateAllowance({ username: user.name, ...request })}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <select
          aria-label={`Role for ${accountLabel(user)}`}
          className="control max-w-full"
          disabled={!canManageAccess || busy || !!user.issue}
          value={selectedRole}
          onChange={(e) => onSelectRole(e.target.value)}
        >
          <option value="">Choose a role</option>
          {readyRoles
            .filter((r) => !user.roles.includes(r.name))
            .map((r) => (
              <option key={r.name} value={r.name}>
                {r.display_name} ·{' '}
                {r.profile === 'app_owner'
                  ? 'Admin'
                  : r.profile === 'admin'
                    ? 'Admin'
                    : r.profile === 'admin_readonly'
                      ? 'Read-only admin'
                      : 'Member'}
              </option>
            ))}
        </select>
        <button
          className="control"
          disabled={
            !canManageAccess ||
            busy ||
            !!user.issue ||
            !selectedRole ||
            user.roles.includes(selectedRole)
          }
          onClick={() => {
            const role = selectedRole
            if (
              readyRoles.find((r) => r.name === role)?.profile === 'app_owner' &&
              !window.confirm(
                `Give ${accountLabel(user)} full app control, including every private album, users, roles and search sync?`,
              )
            )
              return
            if (
              readyRoles.find((r) => r.name === role)?.profile === 'admin' &&
              !window.confirm(
                `Give ${accountLabel(user)} permission to upload, edit and delete gallery content?`,
              )
            )
              return
            void execute({ action: 'grantRole', name: user.name, role })
          }}
        >
          Assign role
        </button>
      </div>
    </section>
  )
}
