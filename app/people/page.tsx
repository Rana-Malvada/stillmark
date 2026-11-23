import { Suspense } from 'react'
import { requireAuth } from '@/lib/identity/auth'
import { PeoplePanel } from '@/components/people/people-panel'

export const dynamic = 'force-dynamic'
export default async function PeoplePage() {
  await requireAuth()
  return (
    <main className="w-full min-w-0 mx-auto">
      <Suspense>
        <PeoplePanel />
      </Suspense>
    </main>
  )
}
