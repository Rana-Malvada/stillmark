import { requirePagedList } from '@/lib/albums/bounded-list-api'
import { pgReadIdentity } from '@/lib/postgres'
import { thumbnailGrantUrls } from '@/lib/media/thumbnail-grant-urls'
import { withBrowseRequest } from '@/lib/browse-request'
import { favoritePhotoPage } from '@/lib/photos/photo-page'
import { albumCaller } from '@/lib/albums/album-access'
import { requireAuth } from '@/lib/identity/auth'
import { privateJson, route } from '@/lib/route'

export const dynamic = 'force-dynamic'
export const GET = withBrowseRequest(
  route(async (req: Request) => {
    await requireAuth()
    const params = new URL(req.url).searchParams
    requirePagedList(params)
    const caller = await albumCaller()
    const page = await pgReadIdentity(caller, () => favoritePhotoPage(params, caller), {
      singleQuery: true,
      disableJit: true,
    })
    const thumbnails = await thumbnailGrantUrls(
      req,
      page.items.map((p) => p.thumbnailStagePath),
    )
    return privateJson({
      ...page,
      items: page.items.map((p, index) => ({
        ...p,
        thumbnailUrl: thumbnails[index],
      })),
    })
  }),
)
