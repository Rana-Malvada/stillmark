import { withBrowseRequest } from '@/lib/browse-request'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { albumCaller, albumMutation } from '@/lib/albums/album-access'
import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, integer, jsonBody, textValue } from '@/lib/http'
import { privateJson, route } from '@/lib/route'
import {
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
  requireFolderWrite,
} from '@/lib/albums/folders'

export const dynamic = 'force-dynamic'

export const GET = withBrowseRequest(
  route({ tag: 'folders' }, async () => {
    await requireAuth()
    const c = await albumCaller()
    const folders = await listFolders(null, c)
    return privateJson(folders)
  }),
)

export const POST = withDatabaseRequest(
  route({ tag: 'folders-create' }, async (req: Request) => {
    await requireSameOrigin()
    const body = await jsonBody(req)
    const { folderName, sortOrder } = body
    if (!folderName) throw new HttpError(400, 'Missing folderName')
    const folderId = await albumMutation((c) =>
      createFolder(
        textValue(folderName, 'folderName'),
        integer(sortOrder ?? 0, 'sortOrder', 0),
        c.mainAdmin && body.personal !== true ? null : c.username,
      ),
    )
    return Response.json({ folderId })
  }),
)

export const PATCH = withDatabaseRequest(
  route({ tag: 'folders-rename' }, async (req: Request) => {
    await requireSameOrigin()
    const body = await jsonBody(req)
    const { folderId, folderName } = body
    if (!folderId || !folderName) throw new HttpError(400, 'Missing folderId or folderName')
    await albumMutation(async (c) => {
      await requireFolderWrite(integer(folderId, 'folderId'), c)
      await renameFolder(integer(folderId, 'folderId'), textValue(folderName, 'folderName'))
    })
    return Response.json({ ok: true })
  }),
)

export const DELETE = withDatabaseRequest(
  route({ tag: 'folders-delete' }, async (req: Request) => {
    await requireSameOrigin()
    const body = await jsonBody(req)
    const { folderId } = body
    if (!folderId) throw new HttpError(400, 'Missing folderId')
    await albumMutation(async (c) => {
      await requireFolderWrite(integer(folderId, 'folderId'), c)
      await deleteFolder(integer(folderId, 'folderId'))
    })
    return Response.json({ ok: true })
  }),
)
