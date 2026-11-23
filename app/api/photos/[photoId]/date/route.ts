import { withDatabaseRequest } from '@/lib/database/database-context'
import { albumMutation, requirePhotoAccess } from '@/lib/albums/album-access'
import { requireSameOrigin } from '@/lib/identity/auth'
import { HttpError, integer, jsonBody } from '@/lib/http'
import { route } from '@/lib/route'
import { setPhotoDateTaken } from '@/lib/photos'

export const PATCH = withDatabaseRequest(
  route(async (req: Request, { params }: { params: Promise<{ photoId: string }> }) => {
    await requireSameOrigin()
    const { photoId } = await params
    const body = await jsonBody(req)
    const value = body.dateTaken
    if (
      value !== null &&
      (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
        !Number.isFinite(Date.parse(value)))
    )
      throw new HttpError(400, 'Enter a valid capture date with time zone')
    if (
      typeof value === 'string' &&
      (value.startsWith('0000') ||
        new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !==
          value.slice(0, 10))
    )
      throw new HttpError(400, 'Invalid calendar date')
    const row = await albumMutation(
      async (c) => {
        await requirePhotoAccess(integer(photoId, 'photoId'), true, c)
        return setPhotoDateTaken(integer(photoId, 'photoId'), value)
      },
      { photoIds: [integer(photoId, 'photoId')] },
    )
    if (!row) throw new HttpError(404, 'Photo not found')
    return Response.json({ ok: true })
  }),
)
