'use client'
import { clientMutation, clientOperation } from '@/lib/client-operation'
import { isAllowances, isOk } from '@/lib/frontend-response-contracts'

import { type FormEvent, useEffect, useState } from 'react'

export function CustomerDefaultsPanel() {
  const [uploads, setUploads] = useState('')
  const [storage, setStorage] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    // oxlint-disable-next-line react/set-state-in-effect -- the flags must be raised after the previous load is aborted in this effect, or its late completion could clear them mid-reload
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const body = await clientOperation(
          '/api/admin/customer-defaults',
          {
            cache: 'no-store',
            signal: controller.signal,
          },
          'Could not load allowances',
          isAllowances,
        )
        if (controller.signal.aborted) return
        setUploads(String(body.uploads))
        setStorage(String(body.bytes / 1073741824))
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Could not load allowances')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- retry is the reload trigger for the Retry button and a rejected save
  }, [retry])
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await clientMutation(
        '/api/admin/customer-defaults',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploads: Number(uploads), storageGiB: Number(storage) }),
        },
        'Could not save allowances',
        isOk,
        () => setRetry((v) => v + 1),
      )
      setNotice('Saved. These limits apply to new accounts only.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save allowances')
    } finally {
      setSaving(false)
    }
  }
  return (
    <section
      className="rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-labelledby="customer-defaults-title"
    >
      <h2 id="customer-defaults-title" className="text-lg font-semibold">
        New account upload limits
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Defaults for new self-service accounts. Existing users keep their current allowance; use Set
        upload allowance on their user card to change it.
      </p>
      <form
        onSubmit={save}
        className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto] items-end"
      >
        <label className="grid gap-1 text-sm">
          Files per account
          <input
            className="control w-full"
            type="number"
            min="0"
            max="1000000"
            step="1"
            required
            value={uploads}
            onChange={(e) => setUploads(e.target.value)}
            disabled={loading || saving}
          />
        </label>
        <label className="grid gap-1 text-sm">
          Upload allowance (GiB)
          <input
            className="control w-full"
            type="number"
            min="0"
            max="10240"
            step="1"
            required
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
            disabled={loading || saving}
          />
        </label>
        <button className="primary-button" disabled={loading || saving || !uploads || !storage}>
          {loading ? 'Loading…' : saving ? 'Saving…' : 'Save defaults'}
        </button>
      </form>
      <p className="mt-3 text-xs text-muted-foreground">
        Lifetime upload admissions, including failed or cancelled transfers; bytes round up per file
        to 8 MiB. Zero requires an admin to grant an allowance. This does not reset usage or change
        paid-search limits.
      </p>
      {notice && (
        <p role="status" className="mt-3 text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}{' '}
          <button
            type="button"
            className="underline"
            disabled={saving}
            onClick={() => setRetry((n) => n + 1)}
          >
            Reload
          </button>
        </p>
      )}
    </section>
  )
}
