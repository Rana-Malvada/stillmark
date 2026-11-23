import { authorizePage } from '@/lib/page-access'
import { ActivityTabs } from '@/components/activity-tabs'
import { requireAccessRead, requireAdminRead } from '@/lib/identity/auth'
import { UserActivityPanel } from '@/components/user-activity-panel'

export const dynamic = 'force-dynamic'
export default async function Page() {
  await authorizePage(requireAdminRead)
  await authorizePage(requireAccessRead)
  return (
    <>
      <ActivityTabs />
      <UserActivityPanel />
    </>
  )
}
