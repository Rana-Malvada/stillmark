import { authorizePage } from '@/lib/page-access'
import { requireAdminRead } from '@/lib/identity/auth'
import { PersonalCostPanel } from '@/components/personal-cost-panel'

export const dynamic = 'force-dynamic'
export default async function Page() {
  await authorizePage(requireAdminRead)
  return <PersonalCostPanel />
}
