import { authorizePage } from '@/lib/page-access'
import { requireAccessRead } from '@/lib/identity/auth'
import { AccessPanel } from '@/components/access-panel'

export const dynamic = 'force-dynamic'
export default async function Page() {
  await authorizePage(requireAccessRead)
  return <AccessPanel />
}
