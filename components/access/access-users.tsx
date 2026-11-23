import { Plus, Users } from 'lucide-react'
import type { Overview } from '@/lib/identity/access-response'
import { AccessUserCard } from './access-user-card'
import type { AccessController } from './use-access-controller'
import type { AccessUserActions, AccessUserForm } from './use-access-editor'
import { input } from './access-presentation'

interface Props {
  data: Overview | null
  username: string | null
  canManageAccess: boolean
  controller: Pick<
    AccessController,
    'busy' | 'loading' | 'execute' | 'setError' | 'updateAllowance'
  >
  form: AccessUserForm
  actions: AccessUserActions
}
export function AccessUsers({ data, username, canManageAccess, controller, form, actions }: Props) {
  const { busy, loading } = controller
  const {
    newName,
    setNewName,
    displayName,
    setDisplayName,
    email,
    setEmail,
    password,
    setPassword,
    createUser,
  } = form
  return (
    <>
      {data && !data.customerAccountsEnabled && (
        <form onSubmit={createUser} className="surface-panel p-5 sm:p-6 space-y-4">
          <h2 className="flex items-center gap-2 font-semibold">
            <Users className="w-4 h-4 text-primary" />
            Create a user
          </h2>
          <div className="grid sm:grid-cols-3 gap-4">
            <label className="text-sm space-y-2">
              <span>Username</span>
              <input
                disabled={!canManageAccess}
                className={input}
                required
                minLength={2}
                maxLength={100}
                pattern="[A-Za-z][A-Za-z0-9_]+"
                autoComplete="off"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="JANE_SMITH"
              />
            </label>
            <label className="text-sm space-y-2">
              <span>Display name</span>
              <input
                disabled={!canManageAccess}
                className={input}
                required
                maxLength={100}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Jane Smith"
              />
            </label>
            <label className="text-sm space-y-2">
              <span>Email</span>
              <input
                disabled={!canManageAccess}
                className={input}
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
              />
            </label>
          </div>
          <label className="block text-sm space-y-2">
            <span>Initial password</span>
            <input
              disabled={!canManageAccess}
              className={input}
              type="password"
              autoComplete="new-password"
              required
              minLength={14}
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Use 14–256 characters with uppercase, lowercase, numbers and symbols. Auth0 also checks
            password strength. Assign a role after creating the user, then share the username,
            password and photo app address privately.{' '}
            {data?.auth0Enabled
              ? data?.permissionAuthority === 'postgres'
                ? 'Creates an Auth0 login with app-managed permissions.'
                : 'Creates the Auth0 login and Snowflake account together. Guests choose Personal Photos on the login screen.'
              : 'No setup link or forced password change. Snowflake may still require MFA.'}
          </p>
          <button className="primary-button" disabled={!canManageAccess || busy || loading}>
            <Plus className="w-4 h-4" />
            Create user
          </button>
        </form>
      )}
      {data?.customerAccountsEnabled && (
        <p className="text-sm text-muted-foreground">
          Users create their own accounts from the sign-in page and reset passwords through Forgot
          password. Manage their access and allowances below.
        </p>
      )}
      {data?.users.length === 0 && (
        <div className="surface-panel p-8 text-center">
          <Users className="w-7 h-7 text-primary mx-auto mb-3" />
          <h2 className="font-semibold">No registered users yet</h2>
          <p className="text-sm text-muted-foreground mt-2">
            Registered accounts will appear here after their first verified sign-in.
          </p>
        </div>
      )}
      <div className="space-y-4">
        {data?.users.map((user) => (
          <AccessUserCard
            key={user.name}
            user={user}
            data={data}
            username={username}
            canManageAccess={canManageAccess}
            controller={controller}
            onResume={actions.onResume}
            onDelete={actions.onDelete}
            passwordEditor={actions.passwordEditor}
            selectedRole={actions.selected[user.name] ?? ''}
            onSelectRole={(role) => actions.onSelectRole(user.name, role)}
          />
        ))}
      </div>
    </>
  )
}
