'use client'
import { visibleAccountName } from '@/lib/identity/account-presentation'

import { useEffect, useId, useRef, useState } from 'react'
import { useChanged } from './use-changed'
import { usePathname } from 'next/navigation'
import { LogOut, Moon, Sun, UserRound } from 'lucide-react'
import { useTheme } from '@/components/theme-provider'

export function AccountMenu({
  username,
  role,
  uploading,
  loggingOut,
  onLogout,
}: {
  username: string | null
  role: 'admin' | 'admin_readonly' | 'viewer' | null
  uploading: boolean
  loggingOut: boolean
  onLogout: () => void
}) {
  username = visibleAccountName(username)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const pathname = usePathname()
  const { resolvedTheme, setTheme } = useTheme()
  if (useChanged(pathname)) setOpen(false)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  const roleLabel =
    role === 'admin_readonly'
      ? 'Read-only admin'
      : role === 'admin'
        ? 'Administrator'
        : role === 'viewer'
          ? 'Member'
          : null
  return (
    <div
      ref={root}
      className="static sm:relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
          trigger.current?.focus()
        }
      }}
      onBlur={(event) => {
        if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node))
          setOpen(false)
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={`Account: ${username ?? 'your account'}`}
        title={username ?? 'Account'}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {username ? (
          username.slice(0, 2).toUpperCase()
        ) : (
          <UserRound className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
      {open && (
        <div
          id={id}
          aria-label="Account"
          className="absolute inset-x-4 top-full z-50 mt-2 max-h-[70dvh] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-xl sm:left-auto sm:right-0 sm:w-64"
        >
          <div className="border-b border-border px-3 py-3">
            <p className="break-words text-sm font-semibold">{username ?? 'Account'}</p>
            {roleLabel && <p className="mt-1 text-xs text-muted-foreground">{roleLabel}</p>}
          </div>
          <button
            type="button"
            className="mt-1 flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          >
            {resolvedTheme === 'dark' ? (
              <Sun className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4" aria-hidden="true" />
            )}
            {resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          </button>
          <a
            href="/account"
            className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent"
          >
            Account settings
          </a>
          <button
            type="button"
            disabled={loggingOut || uploading}
            onClick={onLogout}
            aria-describedby={uploading ? `${id}-upload` : undefined}
            className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
          {uploading && (
            <p id={`${id}-upload`} className="px-3 pb-2 text-xs text-muted-foreground">
              Wait for uploads to finish before logging out.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
