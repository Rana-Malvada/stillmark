import { mediaStage } from '@/lib/snowflake/media-stage'
import { pgQueryOne } from '@/lib/postgres'
import { storageUrlSigner } from '../snowflake/storage-url-signer'
import { HttpError } from '@/lib/http'

/** Only worker-written crop names are signable; nothing else on the derived stage. */
const CROP = /^faces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/

export function validateCropPath(path: unknown): string {
  if (typeof path !== 'string' || !CROP.test(path)) throw new HttpError(400, 'Invalid face crop')
  return path
}

/**
 * Crop path for a face the caller may see. Row security decides visibility: owners see
 * their faces; shared viewers only settled, named faces when the owner shares names;
 * public links nothing. Owners can also view crops in their Ignored list.
 */
export async function visibleCrop(faceId: number): Promise<string> {
  const row = await pgQueryOne<{ crop_path: string | null }>(
    'SELECT crop_path FROM faces WHERE face_id=$1 AND (NOT ignored OR owner_username=photo_security.username())',
    [faceId],
  )
  if (!row?.crop_path) throw new HttpError(404, 'Face not found')
  return validateCropPath(row.crop_path)
}

/** Server-only URL cache. visibleCrop still checks live permissions on every request. */
export async function signCrop(path: string): Promise<string> {
  const crop = validateCropPath(path)
  return storageUrlSigner.get(`GET_PRESIGNED_URL(${mediaStage(crop)}, '${crop}', 300)`, 300)
}
