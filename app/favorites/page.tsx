import { galleryQueryString } from '@/lib/gallery-query'
import { PhotoGrid } from '@/components/photo-grid'

export const dynamic = 'force-dynamic'
export default async function FavoritesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return (
    <main className="w-full min-w-0 mx-auto">
      <PhotoGrid initialQuery={galleryQueryString(await searchParams)} />
    </main>
  )
}
