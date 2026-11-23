import { HttpError, textValue } from '../http'
import { SUPPORTED_EXTS, VIDEO_EXTS } from './upload-processing'

/** The single check of an uploaded file's name and format, used at enqueue and at ingest. */
export function uploadFileKind(fileName: unknown) {
  const filename = textValue(fileName, 'fileName', 512)
  if (/[\\/\\\\]/.test(filename)) throw new HttpError(400, 'Filename must not contain a path')
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!SUPPORTED_EXTS.has(ext)) throw new HttpError(415, 'Unsupported file format')
  return { filename, ext, video: VIDEO_EXTS.has(ext) }
}
