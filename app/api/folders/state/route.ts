import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { accessibleAlbumIds, albumCaller } from '@/lib/albums/album-access'
import { listFolders, setFolderExpanded } from '@/lib/albums/folders'
import { HttpError, integer, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'

export const PUT = withDatabaseRequest(
  route(async (req: Request) => {
    await requireSameOrigin()
    await requireAuth()
    const caller = await albumCaller()
    const body = await jsonBody(req)
    const id = integer(body.folderId, 'folderId', 1)
    if (typeof body.expanded !== 'boolean') throw new HttpError(400, 'expanded must be a boolean')
    const folders = await listFolders(
      caller.mainAdmin ? null : await accessibleAlbumIds(caller),
      caller,
    )
    if (!folders.some((f) => f.folderId === id)) throw new HttpError(404, 'Folder not found')
    await setFolderExpanded(caller.username, id, body.expanded)
    return Response.json({ ok: true })
  }),
)
