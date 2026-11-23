import { withBrowseRequest } from '@/lib/browse-request'
import { requireAuth } from '@/lib/identity/auth'
import { albumCaller, requireAlbumAccess } from '@/lib/albums/album-access'
import { HttpError, integer } from '@/lib/http'
import { privateJson, route } from '@/lib/route'
import { listAlbumPhotosForReview } from '@/lib/photos'
import { pgTransaction } from '@/lib/postgres'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ eventId: string }> }
export const GET = withBrowseRequest(
  route(async (req: Request, { params }: Context) => {
    await requireAuth()
    const eventId = integer((await params).eventId, 'eventId')
    const raw = new URL(req.url).searchParams.get('ids') ?? ''
    if (raw.length > 2400 || !/^[0-9]+(?:,[0-9]+)*$/.test(raw))
      throw new HttpError(400, 'Select saved photo IDs')
    const ids = [...new Set(raw.split(',').map((id) => integer(id, 'photoId')))]
    if (ids.length > 200) throw new HttpError(400, 'Review at most 200 files per request')
    const caller = await albumCaller()
    const rows = await pgTransaction(async () => {
      await requireAlbumAccess(eventId, false, caller)
      return listAlbumPhotosForReview(eventId, ids)
    })
    return privateJson(rows)
  }),
)
