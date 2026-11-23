import { authorizePage } from '@/lib/page-access'
import { redirect } from 'next/navigation'
import { requireMainAdmin } from '@/lib/albums/album-access'

export const dynamic = 'force-dynamic'
export default async function Page() {
  await authorizePage(requireMainAdmin)
  redirect('/admin/activity')
}
