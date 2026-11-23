import { withDatabaseRequest } from '@/lib/database/database-context'
import { requirePhotoAccess } from '@/lib/albums/album-access'
import { requireAuth } from '@/lib/identity/auth'
import { HttpError, integer } from '@/lib/http'
import { route } from '@/lib/route'
import { getPhoto } from '@/lib/photos'
import { getImageProxyUrl } from '@/lib/media/image-urls'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ photoId: string }> }
export const GET = withDatabaseRequest(
  route({ tag: 'photo-url' }, async (req: Request, { params }: Context) => {
    await requireAuth()
    const { photoId } = await params
    const type = new URL(req.url).searchParams.get('type') ?? 'display'
    await requirePhotoAccess(integer(photoId, 'photoId'))
    const photo = await getPhoto(integer(photoId, 'photoId'))
    if (!photo) throw new HttpError(404, 'Not found')

    let path: string | null = null
    if (type === 'original') path = photo.originalStagePath
    else if (type === 'thumbnail') path = photo.thumbnailStagePath
    else path = photo.displayStagePath

    if (!path) throw new HttpError(404, 'No rendition available')

    const url = getImageProxyUrl(path, type === 'original' ? 7200 : 3600)
    return Response.json({ url })
  }),
)
