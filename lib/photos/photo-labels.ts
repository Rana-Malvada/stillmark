import { HttpError, textValue } from '@/lib/http'
import { pgQueryOne } from '@/lib/postgres'

export function photoLabels(body: Record<string, unknown>) {
  if (
    typeof body.caption !== 'string' ||
    body.caption.length > 5000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body.caption)
  )
    throw new HttpError(400, 'Caption must be text, up to 5,000 characters')
  if (!Array.isArray(body.tags) || body.tags.length > 20)
    throw new HttpError(400, 'Use up to 20 tags')
  const tags = body.tags.map((tag) => textValue(tag, 'tag (up to 64 characters)', 64))
  const unique = tags.filter(
    (tag, index) => tags.findIndex((other) => other.toLowerCase() === tag.toLowerCase()) === index,
  )
  return { caption: body.caption.trim() || null, tags: unique }
}

export async function updatePhotoLabels(photoId: number, body: Record<string, unknown>) {
  const labels = photoLabels(body)
  const row = await pgQueryOne(
    `UPDATE photos SET caption=$2,user_tags=$3,updated_at=NOW()
    WHERE photo_id=$1 RETURNING photo_id`,
    [photoId, labels.caption, labels.tags],
  )
  if (!row) throw new HttpError(404, 'Photo not found')
  return labels
}
