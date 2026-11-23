'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/components/auth-provider'
import { clientMutation, clientOperation } from '@/lib/client-operation'
import { ClientResponseError } from '@/lib/client-response'
import { type Account, isAccount, isAccountSaved } from '@/lib/identity/account-response'

export default function AccountPage() {
  const { refresh } = useAuth()
  const [account, setAccount] = useState<Account | null>(null)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const lifetime = useRef<AbortController | null>(null)
  const loadRequest = useRef<AbortController | null>(null)
  const mutation = useRef(false)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async (signal: AbortSignal) => {
    loadRequest.current?.abort()
    const request = new AbortController()
    loadRequest.current = request
    const data = await clientOperation(
      '/api/account',
      {
        signal: AbortSignal.any([signal, request.signal]),
        cache: 'no-store',
      },
      'Unable to load account. Please try again.',
      isAccount,
    ).catch((error) => {
      if (
        !signal.aborted &&
        !request.signal.aborted &&
        error instanceof ClientResponseError &&
        [401, 403].includes(error.status)
      ) {
        setAccount(null)
        setName('')
      }
      throw error
    })
    if (signal.aborted || request.signal.aborted) return
    setAccount(data)
    setName(data.displayName)
    return data
  }, [])
  async function retryLoad() {
    if (!lifetime.current || loading) return
    const signal = lifetime.current.signal
    setLoading(true)
    setMessage('')
    try {
      await load(signal)
    } catch (e) {
      if (!signal.aborted) setMessage(e instanceof Error ? e.message : 'Unable to load account')
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    // oxlint-disable-next-line react/set-state-in-effect -- nothing is set synchronously: load only sets state after its request settles
    void load(controller.signal)
      .catch((e) => {
        if (!controller.signal.aborted) setMessage(e.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
      loadRequest.current?.abort()
    }
  }, [load])
  async function change(method: string, body: object) {
    if (mutation.current || !lifetime.current) return
    const signal = lifetime.current.signal
    mutation.current = true
    setBusy(true)
    setMessage('')
    try {
      await clientMutation(
        '/api/account',
        {
          method,
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        'Unable to update account. Please try again.',
        isAccountSaved,
        async () => {
          await Promise.allSettled([load(signal), refresh()])
        },
      )
      if (signal.aborted) return
      if (method === 'DELETE') {
        window.location.assign('/auth/logout')
        return
      }
      await Promise.all([load(signal), refresh()])
      if (!signal.aborted) setMessage('Profile saved.')
    } catch (e) {
      if (!signal.aborted) setMessage(e instanceof Error ? e.message : 'Request failed')
    } finally {
      mutation.current = false
      if (!signal.aborted) setBusy(false)
    }
  }
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <h1 className="text-3xl font-semibold">Account</h1>
      {message && <p role="status">{message}</p>}
      {!account && !loading && (
        <button className="control" onClick={() => void retryLoad()}>
          Try again
        </button>
      )}
      {account && (
        <>
          <form
            className="surface-panel space-y-4 p-5"
            onSubmit={(e) => {
              e.preventDefault()
              void change('PATCH', { displayName: name })
            }}
          >
            <label className="block space-y-2">
              <span>Display name</span>
              <input
                className="control w-full"
                value={name}
                maxLength={120}
                required
                disabled={!account.publicAccount || busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <p className="text-sm text-muted-foreground">{account.email}</p>
            {account.publicAccount && (
              <button className="primary-button" disabled={busy}>
                Save profile
              </button>
            )}
          </form>
          <section className="surface-panel space-y-3 p-5">
            <h2 className="font-semibold">Password</h2>
            <p>Use Forgot password on the sign-in screen to receive a secure reset link.</p>
            <a href="/auth/recover" className="control inline-block">
              Reset password
            </a>
          </section>
          {account.publicAccount && (
            <>
              <section className="surface-panel space-y-3 p-5">
                <h2 className="font-semibold">Upload allowance</h2>
                <p>
                  {account.uploadsUsed} of {account.uploadLimit} upload admissions used. Contact the
                  administrator for more.
                </p>
                <p className="text-sm text-muted-foreground">
                  Failed or cancelled uploads count toward this allowance. Retrying the same upload
                  does not count again.
                </p>
              </section>
              <section className="surface-panel space-y-3 p-5">
                <h2 className="font-semibold">Delete account</h2>
                <p>
                  Request deletion and disable your account immediately. An administrator completes
                  removal of your stored media and login.
                </p>
                <button
                  className="control text-destructive"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.prompt('Type DELETE to request deletion and disable your account.') ===
                      'DELETE'
                    )
                      void change('DELETE', { confirmation: 'DELETE' })
                  }}
                >
                  Request account deletion
                </button>
              </section>
            </>
          )}
        </>
      )}
    </main>
  )
}
