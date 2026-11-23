'use client'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { latestRequest } from '@/lib/latest-request'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'
import {
  type IdentityStatus,
  type IdentitySummary,
  isIdentityImport,
  isIdentityStatus,
  isIdentitySummary,
} from './identity-data'

const failure = (e: unknown, fallback: string) =>
  e instanceof ClientResponseError ? e.message : fallback
/** Status is global; report reads and downloads belong to the exact selected filters. */
export function useIdentityActivity(
  user: string,
  kind: string,
  days: string,
  canManageAccess: boolean,
) {
  const [status, setStatus] = useState<IdentityStatus[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [rows, setRows] = useState<IdentitySummary['rows']>([])
  const [more, setMore] = useState(false)
  const [importErrors, setImportErrors] = useState<Record<string, string>>({})
  const statusRequests = useRef(latestRequest())
  const reportRequests = useRef(latestRequest())
  const busyRef = useRef('')
  const mounted = useRef(false)
  const filterScope = JSON.stringify([user, kind, days])
  const scopeRef = useRef(filterScope)
  // Committed before any response can be handled, so a late report for other filters is dropped.
  useLayoutEffect(() => {
    scopeRef.current = filterScope
  })
  const readStatus = useCallback(async () => {
    const request = statusRequests.current.begin()
    try {
      const data = await readClientResponse(
        await fetch('/api/user-activity/identity', {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(45000)]),
        }),
        'Unable to load import status',
        isIdentityStatus,
      )
      if (request.current()) setStatus(data)
    } catch (e) {
      if (!request.current()) return
      if (e instanceof ClientResponseError && [401, 403, 404].includes(e.status)) setStatus([])
      throw e
    }
  }, [])
  useEffect(() => {
    const statusOwner = statusRequests.current
    const reportOwner = reportRequests.current
    mounted.current = true
    void readStatus().catch((e) => {
      if (mounted.current) setError(failure(e, 'Unable to load import status'))
    })
    return () => {
      mounted.current = false
      statusOwner.cancel()
      reportOwner.cancel()
    }
  }, [readStatus])
  useEffect(() => {
    reportRequests.current.cancel()
    // oxlint-disable-next-line react/set-state-in-effect -- the reset must follow cancel() in this effect, or a late report for the old filters could repopulate the new ones
    setRows([])
    setMore(false)
    setNotice('')
    setError('')
    if (['summary', 'details'].includes(busyRef.current)) {
      busyRef.current = ''
      setBusy('')
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- filterScope is the reset trigger: new filters must drop the previous report
  }, [filterScope])
  async function run(provider: string) {
    if (!canManageAccess || busyRef.current) return
    busyRef.current = provider
    setBusy(provider)
    setError('')
    setNotice('')
    setImportErrors((p) => ({ ...p, [provider]: '' }))
    setStatus((p) => p.map((s) => (s.provider === provider ? { ...s, error: null } : s)))
    let imported = false
    try {
      const result = await readClientResponse(
        await fetch('/api/user-activity/identity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
          signal: AbortSignal.timeout(90000),
        }),
        'Import failed',
        isIdentityImport,
      )
      imported = true
      if (!mounted.current) return
      setNotice(
        `Imported ${result.imported} new events. ${result.more ? 'More records remain; import again to continue.' : 'Refresh the timeline to see them.'}`,
      )
      await readStatus()
    } catch (e) {
      if (mounted.current) {
        if (imported)
          setError(
            'Import completed, but its status could not be refreshed. Reload this page to check status.',
          )
        else setImportErrors((p) => ({ ...p, [provider]: failure(e, 'Import failed') }))
      }
    } finally {
      busyRef.current = ''
      if (mounted.current) setBusy('')
    }
  }
  async function summaries() {
    if (busyRef.current) return
    const scope = filterScope
    const request = reportRequests.current.begin()
    const current = () => request.current() && scopeRef.current === scope
    busyRef.current = 'summary'
    setBusy('summary')
    setError('')
    try {
      const result = await readClientResponse(
        await fetch(
          '/api/user-activity/summary?' + new URLSearchParams({ user, kind, days: '366' }),
          { signal: AbortSignal.any([request.signal, AbortSignal.timeout(45000)]) },
        ),
        'Unable to load summaries',
        isIdentitySummary,
      )
      if (!current()) return
      setRows(result.rows)
      setMore(result.more)
      setNotice(result.rows.length ? '' : 'No retained summaries match these filters.')
    } catch (e) {
      if (current()) {
        setError(failure(e, 'Unable to load summaries'))
        if (e instanceof ClientResponseError && [401, 403, 404].includes(e.status)) {
          setRows([])
          setMore(false)
        }
      }
    } finally {
      if (current()) {
        busyRef.current = ''
        setBusy('')
      }
    }
  }
  async function download(mode: string) {
    if (busyRef.current) return
    const scope = filterScope
    const request = reportRequests.current.begin()
    const current = () => request.current() && scopeRef.current === scope
    busyRef.current = mode
    setBusy(mode)
    setError('')
    try {
      const response = await fetch(
        '/api/user-activity/export?' +
          new URLSearchParams({ user, kind, days: mode === 'summary' ? '366' : days, mode }),
        { signal: AbortSignal.any([request.signal, AbortSignal.timeout(45000)]) },
      )
      if (!response.ok) await readClientResponse(response, 'Export failed')
      const blob = await response.blob()
      if (!current()) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `gallery-${mode}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      if (current()) setError(failure(e, 'Export failed'))
    } finally {
      if (current()) {
        busyRef.current = ''
        setBusy('')
      }
    }
  }
  return { status, busy, error, notice, rows, more, importErrors, run, summaries, download }
}
