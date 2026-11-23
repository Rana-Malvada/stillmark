import { HttpError } from '../http'

/** The only completion details the server reads; anything else is never stored. */
const COMPLETION_KEYS = [
  'uploadId',
  'totalChunks',
  'fileName',
  'folderName',
  'folderId',
  'eventId',
  'eventName',
  'sortOrder',
  'eventMonth',
  'eventYear',
  'location',
] as const
/** Generous for two 512-character names and a location; far below the request limit. */
const MAX_COMPLETION_BYTES = 8192

/**
 * Completion details are frozen in the upload session and copied to the processing
 * job. Keeping only known keys, within a small size, stops a member from parking
 * megabytes of arbitrary JSON in the catalog with every upload.
 */
export function completionFields(body: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const key of COMPLETION_KEYS) if (body[key] !== undefined) fields[key] = body[key]
  if (Buffer.byteLength(JSON.stringify(fields)) > MAX_COMPLETION_BYTES)
    throw new HttpError(413, 'Upload details are too large')
  return fields
}
