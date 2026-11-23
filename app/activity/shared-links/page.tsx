import { authorizePage } from '@/lib/page-access'
import { requireAdminRead } from '@/lib/identity/auth'
import { ActivityTabs } from '@/components/activity-tabs'
import { SharedLinksPanel } from '@/components/shared-links-panel'

export const dynamic = 'force-dynamic'
export default async function Page() {
  await authorizePage(requireAdminRead)
  return (
    <>
      <ActivityTabs />
      <SharedLinksPanel />
    </>
  )
}
