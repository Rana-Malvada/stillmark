import { type FormEvent, useState } from 'react'
import { accountLabel } from '@/lib/identity/account-presentation'
import type { AccessRequest } from '@/lib/access-management'
import type { User } from '@/lib/identity/access-response'
import { useAccessController } from './use-access-controller'

/** Drafts live with the panel, so changing tabs never discards an unfinished form. */
export function useAccessEditor(username: string | null, canManageAccess: boolean) {
  const [newName, setNewName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordUser, setPasswordUser] = useState('')
  const [userPassword, setUserPassword] = useState('')
  const [roleName, setRoleName] = useState('')
  const [roleLabel, setRoleLabel] = useState('')
  const [profile, setProfile] = useState<'viewer' | 'admin' | 'admin_readonly'>('viewer')
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [recovery, setRecovery] = useState<{ id: string; request: AccessRequest } | null>(null)
  const [recoveryPassword, setRecoveryPassword] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const controller = useAccessController(canManageAccess, (request) => {
    if (request.action === 'deleteUser') setDeleteTarget(null)
    setRecovery(null)
    setRecoveryPassword('')
    if (request.action === 'createUser') {
      setNewName('')
      setDisplayName('')
      setEmail('')
      setPassword('')
    }
    if (request.action === 'setPassword') {
      setPasswordUser('')
      setUserPassword('')
    }
    if (request.action === 'createRole') {
      setRoleName('')
      setRoleLabel('')
    }
  })
  const { data, setError, setNotice, execute } = controller
  function userLabel(name: string) {
    const user = data?.users.find((u) => u.name === name)
    return user ? accountLabel(user) : /^U_[a-f0-9]{32}$/i.test(name) ? 'Removed account' : name
  }
  function createUser(e: FormEvent) {
    e.preventDefault()
    const existing = data?.users.find((u) => u.name === newName.trim().toUpperCase())
    if (existing?.state === 'pending') {
      if (existing.recovery?.actor === username) {
        setRecovery({ id: existing.recovery.id, request: existing.recovery.request })
        setRecoveryPassword(password)
        setNotice(
          'This account has unfinished setup. Resume it below instead of creating it again.',
        )
      } else
        setError(
          'This account has unfinished setup. Ask the manager who started it to resume setup.',
        )
      return
    }
    void execute({ action: 'createUser', name: newName, displayName, email, password })
  }
  function createRole(e: FormEvent) {
    e.preventDefault()
    void execute({
      action: 'createRole',
      name: 'PERSONAL_PHOTOS_GROUP_' + roleName.toUpperCase(),
      displayName: roleLabel,
      profile,
    })
  }
  function resumeFromUser(operation: { id: string; request: AccessRequest }) {
    setRecovery(operation)
    setRecoveryPassword('')
    setNotice('Enter a password in the Resume form above.')
  }
  function resumeFromHistory(operation: { id: string; request: AccessRequest }) {
    setRecovery(operation)
    setRecoveryPassword('')
    setNotice('Enter a password above to resume the saved operation.')
  }
  return {
    controller,
    userLabel,
    userForm: {
      newName,
      setNewName,
      displayName,
      setDisplayName,
      email,
      setEmail,
      password,
      setPassword,
      createUser,
    },
    roleForm: { roleName, setRoleName, roleLabel, setRoleLabel, profile, setProfile, createRole },
    recoveryForm: { recovery, setRecovery, recoveryPassword, setRecoveryPassword },
    deleteTarget,
    setDeleteTarget,
    resumeFromHistory,
    userActions: {
      onResume: resumeFromUser,
      onDelete: setDeleteTarget,
      passwordEditor: {
        name: passwordUser,
        value: userPassword,
        open: (name: string) => {
          setPasswordUser(name)
          setUserPassword('')
        },
        change: setUserPassword,
        close: () => {
          setPasswordUser('')
          setUserPassword('')
        },
      },
      selected,
      onSelectRole: (name: string, role: string) =>
        setSelected((current) => ({ ...current, [name]: role })),
    },
  }
}

export type AccessUserForm = ReturnType<typeof useAccessEditor>['userForm']
export type AccessRoleForm = ReturnType<typeof useAccessEditor>['roleForm']
export type AccessRecoveryForm = ReturnType<typeof useAccessEditor>['recoveryForm']
export type AccessUserActions = ReturnType<typeof useAccessEditor>['userActions']
