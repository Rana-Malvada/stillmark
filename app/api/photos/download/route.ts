import { downloadZip } from '@/lib/photos/download-zip'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { requirePhotosAccess } from '@/lib/albums/album-access'
import { trackAction } from '@/lib/observability/activity-action'
import { requireAuth } from '@/lib/identity/auth'
import { sessionAuthorityRefresher } from '@/lib/identity/session-authority'
import { HttpError } from '@/lib/http'
import { route } from '@/lib/route'
import { photoIds } from '@/lib/photos/photo-management'
import { listDownloadablePhotos, readDownloadablePath } from '@/lib/photos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async (req: Request) => {
    await requireAuth()
    const ids = photoIds((new URL(req.url).searchParams.get('ids') || '').split(',').map(Number))
    await requirePhotosAccess(ids)
    const rows = await listDownloadablePhotos(ids)
    if (rows.length !== ids.length) throw new HttpError(409, 'Some selected files are unavailable')
    // The checks above only choose the candidates. Each file is authorized again from live
    // state while the archive streams; one the caller can no longer read is left out.
    // The caller is read again from the database for each file too: a disabled account, a
    // logged-out session or a withdrawn role stops the files that have not been sent.
    const asCurrentCaller = await sessionAuthorityRefresher()
    const response = await downloadZip(req, rows, (photo) =>
      asCurrentCaller((caller) => readDownloadablePath(photo.photo_id, caller)),
    )
    trackAction('download_requested', 'zip', {
      files: rows.length,
      bytes: rows.reduce((n, r) => n + Number(r.file_size_bytes ?? 0), 0),
      scope: 'zip',
    })
    return response
  }),
)
