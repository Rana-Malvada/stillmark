export interface UploadFolder {
  folderId: number
  folderName: string
  canSelect: boolean
  canEdit: boolean
}
export function watchUploadFolders(apply: (folders: UploadFolder[]) => void) {
  let revision = 0
  let disposed = false
  const refresh = async () => {
    const request = ++revision
    try {
      const response = await fetch('/api/folders', { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      if (disposed || request !== revision || !Array.isArray(data)) return
      apply(data.filter((f: UploadFolder) => f.canSelect))
    } catch {
      // Keep current choices during temporary network failures; server authorization still applies.
    }
  }
  const visible = () => {
    if (document.visibilityState === 'visible') void refresh()
  }
  void refresh()
  window.addEventListener('focus', refresh)
  window.addEventListener('gallery-folders-changed', refresh)
  document.addEventListener('visibilitychange', visible)
  return () => {
    disposed = true
    window.removeEventListener('focus', refresh)
    window.removeEventListener('gallery-folders-changed', refresh)
    document.removeEventListener('visibilitychange', visible)
  }
}
