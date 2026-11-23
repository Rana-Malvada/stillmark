import { galleryPhotoContext } from '@/lib/gallery-query'
import { parseFaceId } from '@/lib/people/face-highlight'
import { PhotoViewer } from '@/components/photo-viewer'

export const dynamic = 'force-dynamic'

export default async function PhotoPage({
  params,
  searchParams,
}: {
  params: Promise<{ photoId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { photoId } = await params
  const query = await searchParams
  const context = galleryPhotoContext(query)
  return (
    <PhotoViewer
      photoId={Number(photoId)}
      context={context}
      initialFaceId={parseFaceId(query.face)}
      initialInfo={query.info === 'open' || query.info === 'expanded'}
      initialExpanded={query.info === 'expanded'}
      initialInfoScroll={
        typeof query.infoScroll === 'string' && /^\d{1,7}$/.test(query.infoScroll)
          ? Number(query.infoScroll)
          : 0
      }
    />
  )
}
