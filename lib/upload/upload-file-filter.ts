/** AppleDouble sidecars and Finder metadata are not media, even with image extensions. */
export function isUploadMetadata(file: { name: string; webkitRelativePath?: string }): boolean {
  const parts = (file.webkitRelativePath || file.name).replace(/\\/g, '/').split('/')
  return (
    file.name.startsWith('._') ||
    parts.some((part) => part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._'))
  )
}

const extensions = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'tiff',
  'tif',
  'heic',
  'heif',
  'mov',
  'mp4',
  'm4v',
])
const mimeExtensions: Record<string, string> = {
  'video/quicktime': 'mov',
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
}
/** iOS can deliver an extensionless File; preserve bytes and use its declared type.
 * The server still validates the actual container/image before accepting it. */
export function selectedMedia(files: File[]): { files: File[]; rejected: number } {
  const accepted: File[] = []
  let rejected = 0
  for (const file of files) {
    if (isUploadMetadata(file)) continue
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (extensions.has(ext)) {
      accepted.push(file)
      continue
    }
    const inferred = mimeExtensions[file.type.toLowerCase()]
    if (inferred && !file.name.includes('.'))
      accepted.push(
        new File([file], `${file.name}.${inferred}`, {
          type: file.type,
          lastModified: file.lastModified,
        }),
      )
    else rejected++
  }
  return { files: accepted, rejected }
}
