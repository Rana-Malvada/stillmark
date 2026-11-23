import type { Overview } from '@/lib/identity/access-response'
import type { AccessRequest } from '@/lib/access-management'
import type { AccessController } from './use-access-controller'
import { actionLabels } from './access-presentation'

interface Props {
  data: Pick<Overview, 'operations'> | null
  username: string | null
  canManageAccess: boolean
  busy: boolean
  userLabel: (name: string) => string
  execute: AccessController['execute']
  onResume: (operation: { id: string; request: AccessRequest }) => void
}
export function AccessAudit({
  data,
  username,
  canManageAccess,
  busy,
  userLabel,
  execute,
  onResume,
}: Props) {
  return (
    <section className="surface-panel p-5">
      <h2 className="font-semibold mb-4">Latest 100 operations</h2>
      <p className="text-xs text-muted-foreground mb-4">
        Each change records the signed-in manager and its outcome. Login links and passwords are
        never saved here.
      </p>
      {!data?.operations.length ? (
        <p className="text-sm text-muted-foreground">No access changes yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left">When / who</th>
                <th className="text-left">Change</th>
                <th className="text-left">Result</th>
              </tr>
            </thead>
            <tbody>
              {data.operations.map((op) => (
                <tr key={op.id}>
                  <td>
                    <p className="whitespace-nowrap">{new Date(op.created_at).toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">{userLabel(op.actor)}</p>
                  </td>
                  <td>
                    {actionLabels[op.request.action]}
                    <p className="text-xs text-muted-foreground break-all">
                      {op.request.action === 'createRole'
                        ? op.request.name
                        : userLabel(op.request.name)}
                      {'role' in op.request ? ` → ${op.request.role}` : ''}
                    </p>
                  </td>
                  <td>
                    <span className={op.state === 'failed' ? 'text-destructive' : ''}>
                      {op.state === 'running' ? 'Unfinished' : op.state}
                    </span>
                    {'password' in op.request && op.state !== 'succeeded' && (
                      <p className="text-xs mt-1">
                        Use the original retry button. If this page was closed, use Resume setup and
                        re-enter the password to resume. Passwords are not retained in history.
                      </p>
                    )}
                    {op.error && <p className="text-xs mt-1">{op.error}</p>}
                    {'password' in op.request &&
                      op.state !== 'succeeded' &&
                      op.actor === username && (
                        <button
                          className="control mt-2"
                          disabled={!canManageAccess || busy}
                          onClick={() => onResume({ id: op.id, request: op.request })}
                        >
                          Resume setup
                        </button>
                      )}
                    {op.state !== 'succeeded' &&
                      op.actor === username &&
                      !('password' in op.request) && (
                        <button
                          className="control mt-2"
                          disabled={!canManageAccess || busy}
                          onClick={() => void execute(op.request, op.id)}
                        >
                          Retry
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
