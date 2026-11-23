import { authorizePage } from '@/lib/page-access'
import { requireMainAdmin } from '@/lib/albums/album-access'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'
export default async function Page() {
  await authorizePage(requireMainAdmin)
  redirect('/admin/processing#search')
}
