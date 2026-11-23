import { clientMutation, clientOperation, UnconfirmedMutationError } from '../client-operation'
import { ClientResponseError } from '../client-response'
import type { UploadFolder } from './upload-folder-refresh'

interface OwnedFolder extends UploadFolder {
  ownerUsername: string | null
}
const normalizedName = (name: string) => name.trim().replace(/\s+/gu, ' ').toLowerCase()
const isCreated = (value: unknown): value is { folderId: number } =>
  !!value &&
  typeof value === 'object' &&
  'folderId' in value &&
  Number.isSafeInteger(value.folderId) &&
  Number(value.folderId) > 0
const isFolders = (value: unknown): value is OwnedFolder[] =>
  Array.isArray(value) &&
  value.every(
    (folder) =>
      folder &&
      Number.isSafeInteger(folder.folderId) &&
      typeof folder.folderName === 'string' &&
      typeof folder.canSelect === 'boolean' &&
      typeof folder.canEdit === 'boolean' &&
      (typeof folder.ownerUsername === 'string' || folder.ownerUsername === null),
  )

/** The server serializes normalized names per owner; recover a lost acknowledgment by reading. */
export async function createUploadFolderRequest(
  name: string,
  username: string,
  timeoutMs = 45_000,
) {
  let recovered: OwnedFolder | undefined
  const reconcile = async () => {
    const folders = await clientOperation(
      '/api/folders',
      { cache: 'no-store' },
      'Unable to check folders. Please try again.',
      isFolders,
      timeoutMs,
    )
    recovered = folders.find(
      (folder) =>
        folder.ownerUsername === username &&
        folder.canSelect &&
        folder.canEdit &&
        normalizedName(folder.folderName) === normalizedName(name),
    )
  }
  try {
    return await clientMutation(
      '/api/folders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderName: name, personal: true }),
      },
      'Unable to create folder. Please try again.',
      isCreated,
      reconcile,
      timeoutMs,
    )
  } catch (error) {
    // A retry can reach the server after the first request commits. Its conflict is definitive,
    // but the existing owned folder is the desired result, not a reason to create another name.
    if (error instanceof ClientResponseError && error.status === 409) {
      try {
        await reconcile()
      } catch {
        throw new UnconfirmedMutationError()
      }
    }
    if (recovered) return { folderId: recovered.folderId }
    throw error
  }
}
