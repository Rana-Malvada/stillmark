import { pgQuery, pgQueryOne } from '../postgres'
import { HttpError } from '../http'
import { publicSelection, selectedPhotos } from '../albums/public-selection'

const fields = [
  'source_filename',
  'ai_description',
  'media_type',
  'date_taken',
  'width',
  'height',
  'file_size_bytes',
  'content_type',
  'duration',
  'camera_make',
  'camera_model',
  'lens_make',
  'lens_model',
  'focal_length',
  'focal_length_35mm',
  'aperture',
  'shutter_speed',
  'iso',
  'exposure_compensation',
  'exposure_program',
  'exposure_mode',
  'metering_mode',
  'white_balance',
  'light_source',
  'scene_capture_type',
  'flash_used',
  'brightness',
  'contrast',
  'saturation',
  'sharpness',
  'color_space',
  'digital_zoom_ratio',
  'artist',
  'copyright',
  'software',
]
const locationFields = [
  'latitude',
  'longitude',
  'altitude',
  'country',
  'region',
  'city',
  'location_name',
]
export async function publicPhotoDetails(
  link: {
    event_id: number
    include_location: boolean
    include_people: boolean
    photo_ids?: number[] | null
  },
  photoId: number,
) {
  const allowed = [...fields, ...(link.include_location ? locationFields : [])]
  const row = await pgQueryOne<Record<string, unknown>>(
    `SELECT ${allowed.join(',')} FROM photos WHERE photo_id=$1 AND event_id=$2${selectedPhotos(3)}`,
    [photoId, link.event_id, publicSelection(link)],
  )
  if (!row) throw new HttpError(404, 'Photo unavailable')
  // Project the response as well as the SQL: never spread arbitrary database fields.
  const details = Object.fromEntries(allowed.map((key) => [key, row[key] ?? null]))
  const people = link.include_people
    ? await pgQuery<{ name: string; box: { x: number; y: number; w: number; h: number } | null }>(
        'SELECT name,box FROM photo_security.public_photo_people($1)',
        [photoId],
      )
    : []
  return { details, people }
}
