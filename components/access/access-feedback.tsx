import { Copy, X } from 'lucide-react'
import type { AccessRequest } from '@/lib/access-management'
import type { AccessController } from './use-access-controller'
import type { AccessRecoveryForm } from './use-access-editor'
import { actionLabels, input } from './access-presentation'

interface Props {
  canManageAccess: boolean
  controller: Pick<
    AccessController,
    | 'data'
    | 'error'
    | 'setError'
    | 'notice'
    | 'setNotice'
    | 'busy'
    | 'setupUrl'
    | 'setSetupUrl'
    | 'setupUser'
    | 'retry'
    | 'execute'
  >
  recoveryForm: AccessRecoveryForm
  userLabel: (name: string) => string
}
/** Feedback and saved-operation recovery remain visible across all three sections. */
export function AccessFeedback({ canManageAccess, controller, recoveryForm, userLabel }: Props) {
  const {
    data,
    error,
    setError,
    notice,
    setNotice,
    busy,
    setupUrl,
    setSetupUrl,
    setupUser,
    retry,
    execute,
  } = controller
  const { recovery, setRecovery, recoveryPassword, setRecoveryPassword } = recoveryForm
  return (
    <>
      {error && (
        <div
          role="alert"
          className="border border-destructive/40 rounded-lg p-4 text-sm text-destructive"
        >
          <p>{error}</p>
          {retry && (
            <button
              className="control mt-3"
              disabled={!canManageAccess || busy}
              onClick={() => void execute(retry.request, retry.id)}
            >
              Retry this operation
            </button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="surface-panel p-4 text-sm">
          {notice}
        </p>
      )}
      {!data?.customerAccountsEnabled && recovery && (
        <form
          className="surface-panel p-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void execute(
              { ...recovery.request, password: recoveryPassword } as AccessRequest,
              recovery.id,
            )
          }}
        >
          <h2 className="font-semibold">
            Resume {actionLabels[recovery.request.action]} · {userLabel(recovery.request.name)}
          </h2>
          <label className="block text-sm">
            Password
            <input
              className={input + ' mt-2'}
              type="password"
              autoComplete="new-password"
              required
              minLength={14}
              maxLength={256}
              disabled={!canManageAccess || busy}
              value={recoveryPassword}
              onChange={(e) => setRecoveryPassword(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            If the previous password was rejected, enter a stronger password with uppercase,
            lowercase, numbers and symbols. If the Auth0 account already exists, its password is
            retained; use Set password after recovery to change it.
          </p>
          <div className="flex gap-2">
            <button className="primary-button" disabled={!canManageAccess || busy}>
              Resume with password
            </button>
            <button
              type="button"
              className="control"
              onClick={() => {
                setRecovery(null)
                setRecoveryPassword('')
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {setupUrl && (
        <section className="surface-panel p-5 space-y-3" aria-label="Login setup link">
          <div className="flex justify-between gap-3">
            <h2 className="font-semibold">Login setup for {setupUser}</h2>
            <button
              className="control"
              aria-label="Hide login link"
              onClick={() => setSetupUrl('')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-sm text-muted-foreground">
            Share this link privately with this user. It expires after four hours and can be used
            once. The app does not email or save it. Snowflake will guide the user through password
            setup and any required MFA.
          </p>
          <label className="block text-sm">
            Private setup link
            <input
              disabled={!canManageAccess}
              className={input + ' mt-2'}
              readOnly
              value={setupUrl}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <button
            className="control inline-flex items-center gap-2"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(setupUrl)
                setNotice('Setup link copied.')
              } catch {
                setError('Copy was unavailable. Select and copy the link above.')
              }
            }}
          >
            <Copy className="w-4 h-4" />
            Copy link
          </button>
          <p className="text-xs text-muted-foreground">
            After setup, open this photo app and sign in with username {setupUser}.
          </p>
        </section>
      )}
    </>
  )
}
