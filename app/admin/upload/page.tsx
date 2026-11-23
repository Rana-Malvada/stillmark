import { albumCaller, canManagePersonal } from '@/lib/albums/album-access'
import { UploadPanel } from '@/components/upload-panel'

export const dynamic = 'force-dynamic'

export default async function UploadPage() {
  const caller = await albumCaller()
  return (
    <main className="w-full min-w-0 py-6">
      <fieldset disabled={!canManagePersonal(caller)}>
        <UploadPanel />
      </fieldset>
    </main>
  )
}
