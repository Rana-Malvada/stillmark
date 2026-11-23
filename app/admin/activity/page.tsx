import { authorizePage } from '@/lib/page-access'
import { ActivityTabs } from '@/components/activity-tabs'
import { requireAdminRead } from '@/lib/identity/auth'
import { ActivityPanel } from '@/components/activity-panel'

export const dynamic = 'force-dynamic'
export default async function Page() {
  await authorizePage(requireAdminRead)
  return (
    <>
      <ActivityTabs />
      <ActivityPanel />
    </>
  )
}
