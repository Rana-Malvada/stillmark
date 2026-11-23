'use client'

import { useEffect, useRef, useState } from 'react'
import type { AccessRequest } from '@/lib/access-management'
import { isAccessResult } from '@/lib/identity/access-response'
import { useAccessOverview } from './use-access-overview'
import { readClientResponse } from '@/lib/client-response'

/** Single-flight writes retain their operation IDs and reconcile through the overview reader. */
export function useAccessController(
  canManageAccess: boolean,
  onSuccess: (request: AccessRequest) => void,
) {
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [setupUrl, setSetupUrl] = useState('')
  const [setupUser, setSetupUser] = useState('')
  const executing = useRef(false)
  const lifetime = useRef(0)
  const mutation = useRef<AbortController | null>(null)
  const [retry, setRetry] = useState<{ id: string; request: AccessRequest } | null>(null)
  const { data, loading, refresh } = useAccessOverview(setError)
  useEffect(() => {
    return () => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- a lifetime counter, not a DOM node: cleanup must bump the live value to fence a pending write
      lifetime.current++
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- holds the newest write, not a DOM node: cleanup must abort the live one
      mutation.current?.abort()
      mutation.current = null
      executing.current = false
    }
  }, [])
  async function write<T>(options: {
    request: (signal: AbortSignal) => Promise<T>
    apply: (result: T) => void
    failed?: () => void
  }) {
    if (!canManageAccess || executing.current) return
    executing.current = true
    const current = lifetime.current
    const controller = new AbortController()
    mutation.current = controller
    setBusy(true)
    setError('')
    setNotice('')
    setSetupUrl('')
    setRetry(null)
    try {
      const body = await options.request(
        AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
      )
      if (lifetime.current !== current) return
      options.apply(body)
      await refresh(true)
    } catch (e) {
      if (lifetime.current !== current) return
      setError(e instanceof Error ? e.message : 'Unable to complete the change')
      options.failed?.()
      await refresh(true)
    } finally {
      if (lifetime.current === current) {
        mutation.current = null
        executing.current = false
        setBusy(false)
      }
    }
  }

  async function execute(request: AccessRequest, id = crypto.randomUUID()) {
    await write({
      request: async (signal) =>
        readClientResponse(
          await fetch('/api/admin/access', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...request, operationId: id }),
            signal,
          }),
          'Access change could not be confirmed. Retry this operation to check its saved result.',
          isAccessResult,
        ),
      apply: (body) => {
        setNotice(body.message)
        if (body.setupUrl) {
          setSetupUrl(body.setupUrl)
          setSetupUser(request.name)
        }
        onSuccess(request)
      },
      failed: () => setRetry({ id, request }),
    })
  }
  async function updateAllowance(request: {
    username: string
    uploads: number
    bytes: number
    aiSearches: number
  }) {
    await write({
      request: async (signal) =>
        readClientResponse(
          await fetch('/api/admin/customer-allowance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal,
          }),
          'Allowance change could not be confirmed. Refresh access before trying again.',
          (value): value is { ok: true } =>
            !!value && typeof value === 'object' && 'ok' in value && value.ok === true,
        ),
      apply: () => setNotice('Upload allowance updated.'),
    })
  }

  return {
    data,
    error,
    setError,
    notice,
    setNotice,
    loading,
    busy,
    setupUrl,
    setSetupUrl,
    setupUser,
    retry,
    refresh,
    execute,
    updateAllowance,
  }
}

export type AccessController = ReturnType<typeof useAccessController>
