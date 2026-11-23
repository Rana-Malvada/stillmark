import sharp from 'sharp'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pgQueryOne } from '../postgres'
import { publicAlbum, shareHeaders } from './public-albums'
import { getPresignedUrl, invalidateMediaUrl } from '../media/image-urls'
import { fetchMedia } from '../media/media-fetch'
import { deployment } from '@/config/deployment.mjs'

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
export function sharedLinkMetadata(token: string, title: string) {
  const url = `${deployment.GATEWAY_ORIGIN}/share/${encodeURIComponent(token)}`
  const image = `${url}?asset=og-image&v=1`
  const values = {
    'og:type': 'website',
    'og:site_name': 'Stillmark',
    'og:title': title,
    'og:description': 'View this shared album on Stillmark.',
    'og:url': url,
    'og:image': image,
    'og:image:type': 'image/jpeg',
    'og:image:width': '1200',
    'og:image:height': '630',
    'og:image:alt': 'Shared album preview with Stillmark branding',
  }
  return (
    Object.entries(values)
      .map(([key, value]) => `<meta property="${key}" content="${escape(value)}">`)
      .join('') +
    `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escape(title)}"><meta name="twitter:image" content="${escape(image)}">`
  )
}

/** Only derived thumbnails from the link's permitted selection; never originals or EXIF. */
export async function sharedLinkPreview(token: string, signal: AbortSignal) {
  const link = await publicAlbum(token)
  const photo = await pgQueryOne<{ thumbnail_stage_path: string }>(
    `SELECT p.thumbnail_stage_path FROM photos p JOIN events e ON e.event_id=p.event_id
     WHERE p.event_id=$1 AND ($2::integer[] IS NULL OR p.photo_id=ANY($2::integer[]))
       AND p.ingest_status='READY' AND p.thumbnail_stage_path IS NOT NULL
       AND p.thumbnail_stage_path IS DISTINCT FROM p.original_stage_path
     ORDER BY (p.photo_id=e.cover_photo_id) DESC NULLS LAST,p.photo_id LIMIT 1`,
    [link.event_id, link.photo_ids],
  )
  let background: Buffer | undefined
  if (photo) {
    // A storage outage must not prevent a safe branded preview. Bound bytes and time.
    try {
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)])
      const path = photo.thumbnail_stage_path
      let response = await fetchMedia(await getPresignedUrl(path), undefined, boundedSignal)
      if (response.status === 403) {
        await response.body?.cancel()
        invalidateMediaUrl(path)
        response = await fetchMedia(await getPresignedUrl(path), undefined, boundedSignal)
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error('Preview unavailable')
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.length
          if (size > 5 * 1024 * 1024) throw new Error('Preview too large')
          chunks.push(value)
        }
      } finally {
        await reader.cancel()
      }
      background = await sharp(Buffer.concat(chunks), { limitInputPixels: 16000000 })
        .rotate()
        .resize(1200, 630, { fit: 'cover' })
        .toBuffer()
    } catch {
      signal.throwIfAborted()
    }
  }
  const logo = await sharp(await readFile(join(process.cwd(), 'public/icon.svg')))
    .resize(72, 72)
    .png()
    .toBuffer()
  const strip = Buffer.from(
    '<svg width="1200" height="110"><rect width="1200" height="110" fill="#201e1b"/><text x="120" y="71" font-family="sans-serif" font-size="42" fill="#f5f2eb">Stillmark</text></svg>',
  )
  const canvas = background
    ? sharp(background)
    : sharp({ create: { width: 1200, height: 630, channels: 3, background: '#302b23' } })
  const image = await canvas
    .composite([
      { input: strip, left: 0, top: 520 },
      { input: logo, left: 28, top: 539 },
    ])
    .jpeg({ quality: 85 })
    .toBuffer()
  // Revocations during storage fetching/rendering must also be respected.
  await publicAlbum(token)
  return new Response(new Uint8Array(image), {
    headers: { ...shareHeaders, 'Content-Type': 'image/jpeg' },
  })
}
