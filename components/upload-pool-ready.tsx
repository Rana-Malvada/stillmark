'use client'
import { useEffect, useState } from 'react'
import { ensureUploadPoolReady } from '@/lib/upload/upload-pool-client'

export function UploadPoolReady() {
  const [status, setStatus] = useState('Starting upload service…')
  const [error, setError] = useState(false)
  useEffect(() => {
    let mounted = true
    ensureUploadPoolReady().then(
      () => {
        if (mounted) setStatus('Upload service ready')
      },
      (e) => {
        if (mounted) {
          setStatus(e.message)
          setError(true)
        }
      },
    )
    return () => {
      mounted = false
    }
  }, [])
  return (
    <p role={error ? 'alert' : 'status'} className="text-sm text-muted-foreground">
      {status}
    </p>
  )
}
