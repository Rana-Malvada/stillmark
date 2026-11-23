import { accountDisplayNames } from '@/lib/identity/account-display-name'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireSameOrigin } from '@/lib/identity/auth'
import { albumMutation, requireAlbumAccess } from '@/lib/albums/album-access'
import {
  addAlbumShare,
  type AlbumVisibility,
  isActiveGalleryUsername,
  listAlbumShares,
  revokeAlbumShare,
  setAlbumVisibility,
  transferAlbumOwnership,
} from '@/lib/albums/album-sharing'
import { HttpError, integer, jsonBody, textValue } from '@/lib/http'
import { route } from '@/lib/route'
import { trackAction } from '@/lib/observability/activity-action'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async (_req: Request, { params }: { params: Promise<{ eventId: string }> }) => {
    const id = integer((await params).eventId, 'eventId')
    const a = await requireAlbumAccess(id)
    const shares =
      a.canEdit || a.owner_username === a.caller.username ? await listAlbumShares(id) : []
    const labels = await accountDisplayNames([a.owner_username, ...shares.map((s) => s.username)])
    return Response.json(
      {
        owner: a.owner_username,
        ownerDisplayName: labels.get(a.owner_username),
        visibility: a.visibility,
        canEdit: a.canEdit,
        mainAdmin: a.caller.mainAdmin,
        shares: shares.map((s) => ({ ...s, displayName: labels.get(s.username) })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }),
)
export const POST = withDatabaseRequest(
  route(async (req: Request, { params }: { params: Promise<{ eventId: string }> }) => {
    await requireSameOrigin()
    const id = integer((await params).eventId, 'eventId')
    const body = await jsonBody(req, 4096)
    await albumMutation(async (c) => {
      await requireAlbumAccess(id, true, c)
      if (body.action === 'visibility') {
        // requireAlbumAccess above already limits this to the album owner or main admin.
        if (!['PRIVATE', 'GALLERY'].includes(String(body.visibility)))
          throw new HttpError(400, 'Invalid album visibility')
        await setAlbumVisibility(id, body.visibility as AlbumVisibility)
        return
      }
      const rawUsername = textValue(body.username, 'username', 255)
      const username = /^U_[0-9a-f]{32}$/.test(rawUsername)
        ? rawUsername
        : rawUsername.toUpperCase()
      if (body.action === 'revoke') {
        await revokeAlbumShare(id, username)
        return
      }
      if (!(await isActiveGalleryUsername(username)))
        throw new HttpError(400, 'Enter an active gallery username')
      if (body.action === 'share') {
        await addAlbumShare(id, username, c.username)
        return
      }
      if (body.action === 'transfer') {
        if (!c.mainAdmin) throw new HttpError(403, 'Only the main admin can transfer ownership')
        await transferAlbumOwnership(id, username)
        return
      }
      throw new HttpError(400, 'Invalid sharing action')
    })
    trackAction('album_access_changed', `album:${id}`)
    return Response.json({ ok: true })
  }),
)
