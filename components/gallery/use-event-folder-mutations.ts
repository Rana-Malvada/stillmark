'use client'
import { type Dispatch, type SetStateAction, useRef, useState } from 'react'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'
import type { FolderData } from './event-grid-data'

function folderChanged(value: unknown): value is { ok: true } {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === true
}

/** Keeps folder commands and their form ownership separate from catalog reads. */
export function useEventFolderMutations({
  mine,
  mainAdmin,
  username,
  folders,
  setFolders,
  setRevision,
  setFolderError,
}: {
  mine: boolean
  mainAdmin: boolean
  username: string | null
  folders: FolderData[]
  setFolders: Dispatch<SetStateAction<FolderData[]>>
  setRevision: Dispatch<SetStateAction<number>>
  setFolderError: Dispatch<SetStateAction<string>>
}) {
  const [newFolderName, setNewFolderName] = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [folderMutationBusy, setFolderMutationBusy] = useState(false)
  const folderMutationPending = useRef(false)
  const runFolderMutation = async (fallback: string, work: () => Promise<void>) => {
    // The ref also blocks a second event before React renders the disabled controls.
    if (folderMutationPending.current) return false
    folderMutationPending.current = true
    setFolderMutationBusy(true)
    setFolderError('')
    try {
      await work()
      return true
    } catch (error) {
      setFolderError(error instanceof ClientResponseError ? error.message : fallback)
      return false
    } finally {
      folderMutationPending.current = false
      setFolderMutationBusy(false)
    }
  }

  const handleCreateFolder = async () => {
    const folderName = newFolderName.trim().replace(/\s+/gu, ' ')
    if (!folderName) return
    await runFolderMutation('Unable to create folder. Please try again.', async () => {
      const response = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderName, personal: mine }),
      })
      const data = await readClientResponse<{ folderId: number }>(
        response,
        'Unable to create folder. Please try again.',
        (value): value is { folderId: number } =>
          typeof value === 'object' &&
          value !== null &&
          'folderId' in value &&
          Number.isSafeInteger(value.folderId) &&
          Number(value.folderId) > 0,
      )
      setFolders((current) => [
        ...current,
        {
          folderId: data.folderId,
          folderName,
          sortOrder: 0,
          ownerUsername: mine || !mainAdmin ? username : null,
          canEdit: true,
          canSelect: true,
        },
      ])
      setNewFolderName('')
      setShowNewFolder(false)
    })
  }

  const handleRenameFolder = (folderId: number, name: string) =>
    runFolderMutation('Unable to rename folder. Please try again.', async () => {
      const response = await fetch('/api/folders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, folderName: name }),
      })
      await readClientResponse(
        response,
        'Unable to rename folder. Please try again.',
        folderChanged,
      )
      setFolders((current) =>
        current.map((folder) =>
          folder.folderId === folderId
            ? { ...folder, folderName: name.trim().replace(/\s+/gu, ' ') }
            : folder,
        ),
      )
    })

  const handleDeleteFolder = async (folderId: number): Promise<boolean> => {
    const folder = folders.find((f) => f.folderId === folderId)
    if (!folder?.canEdit || folderMutationPending.current) return false
    if (
      !window.confirm(
        `Delete folder "${folder.folderName}"? Albums and their photos/videos will NOT be deleted. The albums will appear outside folders in their current collection or personal section (under Uncategorized when other folders are present).`,
      )
    )
      return false
    return runFolderMutation('Unable to delete folder. Please try again.', async () => {
      const response = await fetch('/api/folders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      })
      await readClientResponse(
        response,
        'Unable to delete folder. Please try again.',
        folderChanged,
      )
      setFolders((current) => current.filter((f) => f.folderId !== folderId))
      window.dispatchEvent(new Event('gallery-folders-changed'))
      setRevision((n) => n + 1)
    })
  }

  return {
    newFolderName,
    setNewFolderName,
    showNewFolder,
    setShowNewFolder,
    folderMutationBusy,
    handleCreateFolder,
    handleRenameFolder,
    handleDeleteFolder,
  }
}
