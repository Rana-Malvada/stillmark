'use client'
import { useEffect, useRef, useState } from 'react'
import { visibleAccountName } from '@/lib/identity/account-presentation'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FolderOpen,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import { albumGridClass } from '../album-card'
import { EventCard } from './event-presentation'
import type { EventData, FolderData } from './event-grid-data'

function FolderActions({
  name,
  onRename,
  onDelete,
  busy,
}: {
  name: string
  onRename: () => void
  onDelete: () => void
  busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  return (
    <div
      ref={root}
      className="relative ml-auto"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setOpen(false)
          trigger.current?.focus()
        }
      }}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false)
      }}
    >
      <button
        ref={trigger}
        aria-label={`Folder actions for ${name}`}
        disabled={busy}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center w-11 h-11 rounded-lg hover:bg-primary/10"
      >
        <Ellipsis className="w-5 h-5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 w-44 rounded-lg border border-border bg-card p-1 shadow-xl">
          <button
            disabled={busy}
            onClick={() => {
              setOpen(false)
              onRename()
            }}
            className="flex items-center gap-2 w-full min-h-11 px-3 rounded hover:bg-muted"
          >
            <Pencil className="w-4 h-4" />
            Rename
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
            className="flex items-center gap-2 w-full min-h-11 px-3 rounded text-destructive hover:bg-muted"
          >
            <Trash2 className="w-4 h-4" />
            Delete folder
          </button>
        </div>
      )}
    </div>
  )
}

export function FolderSection({
  folder,
  showOwner = false,
  events,
  onRename,
  onDelete,
  total,
  onMore,
  moreBusy,
  mutationBusy,
}: {
  folder: FolderData
  showOwner?: boolean
  events: EventData[]
  onRename: (id: number, name: string) => Promise<boolean>
  onDelete: (id: number) => Promise<boolean>
  total?: number
  onMore: () => void
  moreBusy: boolean
  mutationBusy: boolean
}) {
  const [expanded, setExpanded] = useState(folder.expanded !== false)
  const [savingExpansion, setSavingExpansion] = useState(false)
  const [expansionError, setExpansionError] = useState('')
  const toggleExpanded = async () => {
    if (savingExpansion) return
    const next = !expanded
    setExpanded(next)
    setSavingExpansion(true)
    setExpansionError('')
    try {
      const response = await fetch('/api/folders/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: folder.folderId, expanded: next }),
      })
      if (!response.ok) throw new Error('Unable to save folder state. Please try again.')
    } catch {
      setExpanded(!next)
      setExpansionError('Unable to save folder state. Please try again.')
    } finally {
      setSavingExpansion(false)
    }
  }
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(folder.folderName)

  const handleSave = async () => {
    if (mutationBusy || !name.trim()) return
    if (await onRename(folder.folderId, name)) setEditing(false)
  }

  return (
    <div className="mb-6 mx-4 sm:mx-8">
      <div className="flex flex-wrap items-center gap-2 py-1 mb-2">
        <button
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${folder.folderName}`}
          aria-expanded={expanded}
          disabled={savingExpansion}
          onClick={toggleExpanded}
          className="flex items-center justify-center w-11 h-11 shrink-0 text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <FolderOpen className="w-4 h-4 text-muted-foreground" />
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              aria-label="Folder name"
              value={name}
              disabled={mutationBusy}
              maxLength={255}
              onChange={(e) => setName(e.target.value)}
              className="px-2 py-0.5 text-sm bg-background border border-border rounded"
              autoFocus
            />
            <button
              aria-label="Save folder name"
              disabled={mutationBusy || !name.trim()}
              onClick={() => void handleSave()}
              className="p-1 text-success"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              aria-label="Cancel folder rename"
              disabled={mutationBusy}
              onClick={() => {
                setEditing(false)
                setName(folder.folderName)
              }}
              className="p-1 text-muted-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <>
            <span className="min-w-0 text-base font-medium tracking-tight">
              {folder.folderName}
              {showOwner && (
                <span className="block text-sm font-normal text-muted-foreground">
                  {visibleAccountName(folder.ownerDisplayName)}
                </span>
              )}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {total ?? events.length}
            </span>
            {folder.canEdit && (
              <FolderActions
                name={folder.folderName}
                busy={mutationBusy}
                onRename={() => {
                  setName(folder.folderName)
                  setEditing(true)
                }}
                onDelete={() => void onDelete(folder.folderId)}
              />
            )}
          </>
        )}
      </div>
      {expansionError && (
        <p role="alert" className="px-5 text-sm text-destructive">
          {expansionError}
        </p>
      )}
      {expanded && (
        <div className={albumGridClass}>
          {events.map((e) => (
            <EventCard key={e.eventId} event={e} />
          ))}
          {total !== undefined && events.length < total && (
            <div className="col-span-full pt-1">
              <button
                className="control"
                disabled={moreBusy}
                onClick={onMore}
                aria-label={`More albums in ${folder.folderName}`}
              >
                {moreBusy ? 'Loading…' : 'More albums'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
