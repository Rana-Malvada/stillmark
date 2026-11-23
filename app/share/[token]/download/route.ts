import { withPublicRequest } from '@/lib/public-request'
import { withPublicDatabase } from '@/lib/database/database-context'
import { publicAlbum, shareHeaders, tokenHash } from '@/lib/albums/public-albums'
import { downloadZip } from '@/lib/photos/download-zip'
import { HttpError } from '@/lib/http'
import { listPublicDownloadPhotos, readPublicDownloadPath } from '@/lib/photos/public-photos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function publicHandler(req: Request, c: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await c.params
    return await withPublicDatabase(
      tokenHash(token),
      async () => {
        const authorize = async () => {
          const link = await publicAlbum(token)
          if (!link.allow_downloads) throw new HttpError(403, 'Original downloads are disabled')
          return link
        }
        const link = await authorize()
        // No gallery pagination: include every original, including videos.
        const rows = await listPublicDownloadPhotos(link)
        if (rows.some((row) => row.ingest_status !== 'READY' || !row.original_stage_path))
          throw new HttpError(409, 'Some album files are not ready. Please try again later.')
        const name = link.event_name.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 100) || 'album'
        // The rows are only candidates. Each file is authorized again from live state before
        // its original is opened and before its bytes are appended: the link must still be
        // valid and allow downloads (otherwise the transfer stops), and the photo must still
        // be in the album and selection (otherwise that file is left out).
        return downloadZip(
          req,
          rows,
          async (photo) => readPublicDownloadPath(await authorize(), photo.photo_id),
          `${name}.zip`,
          shareHeaders,
        )
      },
      req.signal,
    )
  } catch (error) {
    return new Response(error instanceof HttpError ? error.message : 'Album download unavailable', {
      status: error instanceof HttpError ? error.status : 500,
      headers: shareHeaders,
    })
  }
}

export const GET = withPublicRequest(publicHandler)
