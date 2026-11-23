import { peopleApi, useChange } from './shared'
import type { Settings } from './types'

export function SettingsSection({
  settings,
  readOnly,
  onChange,
}: {
  settings: Settings
  readOnly: boolean
  onChange: () => Promise<void>
}) {
  const { run, busy, bar } = useChange(onChange)
  const toggle = (key: keyof Settings, value: boolean, message: string) =>
    run(message, () => peopleApi('/api/people/settings', 'PATCH', { [key]: value }))
  const deleteAll = () => {
    if (
      !window.confirm(
        'Delete all face data for your library? This removes every face, name, match and change history and turns People off. Your photos are not affected. This cannot be undone.',
      )
    )
      return
    void run('Face data deleted', () => peopleApi('/api/people/settings', 'DELETE'))
  }
  return (
    <section aria-label="Settings" className="w-full min-w-0 space-y-6 text-sm">
      {bar}
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={settings.enabled}
          disabled={readOnly || busy}
          onChange={(e) =>
            toggle(
              'enabled',
              e.target.checked,
              e.target.checked ? 'People turned on' : 'People turned off',
            )
          }
        />
        <span>
          <span className="font-medium block">Find people in my photos</span>
          <span className="text-muted-foreground">
            Scans faces in your albums to group them. Face data stays in your library and is never
            used to train models. Turning this off stops new scans; existing names stay until you
            delete them.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={settings.shareNames}
          disabled={readOnly || busy || !settings.enabled}
          onChange={(e) =>
            toggle(
              'shareNames',
              e.target.checked,
              e.target.checked ? 'Names shared' : 'Names no longer shared',
            )
          }
        />
        <span>
          <span className="font-medium block">Show names to people I share albums with</span>
          <span className="text-muted-foreground">
            They see names only on photos they can already open. Public links never show names.
          </span>
        </span>
      </label>
      <div className="border-t border-border pt-6">
        <p className="font-medium">Delete face data</p>
        <p className="text-muted-foreground mb-3">
          Removes every face, name and match for your library and turns People off.
        </p>
        <button
          type="button"
          onClick={deleteAll}
          disabled={readOnly || busy}
          className="rounded-md border border-destructive text-destructive px-3 py-1 hover:bg-destructive/10 disabled:opacity-50"
        >
          Delete face data
        </button>
      </div>
    </section>
  )
}
