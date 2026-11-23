import { photoReturnPath } from '@/lib/photos/photo-return'
import { requireAuth } from '@/lib/identity/auth'
import { PersonDetail } from '@/components/people/person-detail'

export const dynamic = 'force-dynamic'
export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ personId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAuth()
  const { personId } = await params
  const returnTo = photoReturnPath((await searchParams).returnTo)
  return (
    <main className="w-full min-w-0 mx-auto pt-5">
      <PersonDetail key={personId} personId={personId} returnTo={returnTo} />
    </main>
  )
}
