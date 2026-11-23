import { readClientResponse } from '../client-response'

export interface FolderOption {
  canSelect: boolean
  canEdit: boolean
  folderId: number
  folderName: string
}
export function isFolderOptions(value: unknown): value is FolderOption[] {
  return (
    Array.isArray(value) &&
    value.every(
      (folder) =>
        folder !== null &&
        typeof folder === 'object' &&
        Number.isSafeInteger(folder.folderId) &&
        folder.folderId > 0 &&
        typeof folder.folderName === 'string' &&
        typeof folder.canSelect === 'boolean' &&
        typeof folder.canEdit === 'boolean',
    )
  )
}
export async function loadFolderOptions(signal: AbortSignal) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(45000)])
  const response = await fetch('/api/folders', { signal })
  const folders = await readClientResponse(
    response,
    'Unable to load folders. Please retry.',
    isFolderOptions,
  )
  signal.throwIfAborted()
  return folders.filter((folder) => folder.canSelect)
}
