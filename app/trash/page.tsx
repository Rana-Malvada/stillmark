import { requireAuth } from '@/lib/identity/auth'
import { TrashPanel } from '@/components/trash-panel'

export const dynamic = 'force-dynamic'
export default async function TrashPage() {
  await requireAuth()
  return <TrashPanel />
}
