'use client'

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAuth } from './auth-provider'
import { CustomerDefaultsPanel } from './customer-defaults-panel'
import { useAccessEditor } from './access/use-access-editor'
import { AccessDeleteDialog } from './access/access-delete-dialog'
import { AccessFeedback } from './access/access-feedback'
import { AccessUsers } from './access/access-users'
import { AccessRoles } from './access/access-roles'
import { AccessAudit } from './access/access-audit'

export function AccessPanel() {
  const { username, canManageAccess } = useAuth()
  const [tab, setTab] = useState<'users' | 'roles' | 'history'>('users')
  const editor = useAccessEditor(username, canManageAccess)
  const { controller } = editor
  const { data, error, setError, loading, busy, refresh, execute } = controller
  return (
    <div className="report-page w-full min-w-0 px-5 sm:px-8 py-5 space-y-4">
      <AccessDeleteDialog
        deleteTarget={editor.deleteTarget}
        setDeleteTarget={editor.setDeleteTarget}
        busy={busy}
        error={error}
        execute={execute}
      />
      <div className="page-header">
        <div>
          <p className="eyebrow mb-1.5">Gallery access</p>
          <h1 className="page-title">Users &amp; Roles</h1>
        </div>
        <button
          className="control flex items-center gap-2"
          disabled={loading || busy}
          onClick={() => {
            setError('')
            void refresh()
          }}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh access
        </button>
      </div>
      <p className="text-sm text-muted-foreground max-w-3xl">
        Members manage their libraries and view albums shared with them. Admins manage the app,
        users, and all albums. Existing legacy assignments remain visible until migrated.
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Access sections">
        {(['users', 'roles', 'history'] as const).map((t) => (
          <button
            key={t}
            aria-pressed={tab === t}
            className={tab === t ? 'primary-button' : 'control'}
            onClick={() => setTab(t)}
          >
            {t === 'users' ? 'Users' : t === 'roles' ? 'Roles' : 'Audit history'}
            {t === 'users' && data ? ` · ${data.users.length}` : ''}
          </button>
        ))}
      </div>
      {tab === 'users' && data?.customerAccountsEnabled && canManageAccess && (
        <CustomerDefaultsPanel />
      )}
      <AccessFeedback
        canManageAccess={canManageAccess}
        controller={controller}
        recoveryForm={editor.recoveryForm}
        userLabel={editor.userLabel}
      />
      {tab === 'users' && (
        <AccessUsers
          data={data}
          username={username}
          canManageAccess={canManageAccess}
          controller={controller}
          form={editor.userForm}
          actions={editor.userActions}
        />
      )}
      {tab === 'roles' && (
        <AccessRoles
          data={data}
          canManageAccess={canManageAccess}
          busy={busy}
          loading={loading}
          form={editor.roleForm}
        />
      )}
      {tab === 'history' && (
        <AccessAudit
          data={data}
          username={username}
          canManageAccess={canManageAccess}
          busy={busy}
          userLabel={editor.userLabel}
          execute={execute}
          onResume={editor.resumeFromHistory}
        />
      )}
      <p className="text-xs text-muted-foreground">
        {loading
          ? 'Reading access…'
          : data
            ? `Checked ${new Date(data.refreshedAt).toLocaleString()}. `
            : ''}
        Refresh reads current{' '}
        {data?.permissionAuthority === 'postgres'
          ? 'app permissions'
          : 'Snowflake role assignments'}
        . No automatic polling.
      </p>
    </div>
  )
}
