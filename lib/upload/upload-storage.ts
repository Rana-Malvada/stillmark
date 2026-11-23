import type { UploadBatch } from './upload-queue'

export interface FileIdentity {
  name: string
  size: number
  lastModified: number
  relativePath: string
}
export const fileIdentity = (file: File): FileIdentity => ({
  name: file.name,
  size: file.size,
  lastModified: file.lastModified,
  relativePath: file.webkitRelativePath || '',
})
export interface SavedUpload {
  identities?: FileIdentity[]
  batch: UploadBatch
  fields: Record<string, unknown>
  uploadIds: string[]
  frozen: (Record<string, unknown> | null)[]
}
export interface UploadStorage {
  load(): Promise<{ saved: SavedUpload; files: (File | null)[] }[]>
  create(saved: SavedUpload, files: File[]): Promise<void>
  checkpoint(saved: SavedUpload, completedIndex?: number): Promise<void>
  remove(id: string): Promise<void>
}
export function browserUploadStorage(owner: string): UploadStorage {
  const prefix = encodeURIComponent(owner) + ':'
  let opening: Promise<IDBDatabase> | undefined
  const db = () =>
    (opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('personal-photos-uploads', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('batches')
        request.result.createObjectStore('files')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }))
  const transaction = async (work: (tx: IDBTransaction) => void) => {
    const database = await db()
    return new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['batches', 'files'], 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('Local storage canceled'))
      work(tx)
    })
  }
  const remove = async (id: string) =>
    transaction((tx) => {
      tx.objectStore('batches').delete(prefix + id)
      const cursor = tx
        .objectStore('files')
        .openKeyCursor(IDBKeyRange.bound(prefix + id + ':', prefix + id + ':\uffff'))
      cursor.onsuccess = () => {
        if (cursor.result) {
          tx.objectStore('files').delete(cursor.result.primaryKey)
          cursor.result.continue()
        }
      }
    })
  return {
    async load() {
      const database = await db()
      return new Promise((resolve, reject) => {
        const tx = database.transaction(['batches', 'files'], 'readonly')
        const result: { saved: SavedUpload; files: (File | null)[] }[] = []
        const cursor = tx
          .objectStore('batches')
          .openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'))
        cursor.onsuccess = () => {
          const row = cursor.result
          if (!row) return
          const saved = row.value as SavedUpload
          const files: (File | null)[] = saved.batch.files.map(() => null)
          result.push({ saved, files })
          saved.batch.files.forEach((_, i) => {
            const request = tx.objectStore('files').get(prefix + saved.batch.id + ':' + i)
            request.onsuccess = () => {
              files[i] = request.result ?? null
            }
          })
          row.continue()
        }
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(tx.error)
      })
    },
    create: (saved, _files) =>
      transaction((tx) => {
        tx.objectStore('batches').put(saved, prefix + saved.batch.id)
        // Progress only: new uploads never duplicate media blobs in IndexedDB.
      }),
    checkpoint: (saved, index) =>
      transaction((tx) => {
        tx.objectStore('batches').put(saved, prefix + saved.batch.id)
        if (index !== undefined)
          tx.objectStore('files').delete(prefix + saved.batch.id + ':' + index)
      }),
    remove,
  }
}
