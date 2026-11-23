import { authorizePage } from '@/lib/page-access'
import { requireMainAdmin } from '@/lib/albums/album-access'
import { ActivityTabs } from '@/components/activity-tabs'
import { FaceScanPanel } from '@/components/face-scan-panel'
import { VideoPreparationPanel } from '@/components/video-preparation-panel'
import { SearchBatchPanel } from '@/components/search-batch-panel'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
export default async function Page() {
  await authorizePage(requireMainAdmin)
  const automatic = flagOn('AUTOMATIC_MEDIA_PROCESSING_ENABLED')
  return (
    <>
      <ActivityTabs />
      <main className="report-page w-full min-w-0 px-5 sm:px-8 py-5 space-y-4">
        <h1 className="page-title">Processing</h1>
        <p className="text-sm text-muted-foreground">
          {automatic
            ? 'New uploads are processed automatically. Workers stay ready for 15 minutes after their last work.'
            : 'Processing status and recovery.'}
        </p>
        <section id="faces">
          <FaceScanPanel automatic={automatic} />
        </section>
        <section id="videos">
          <VideoPreparationPanel automatic={automatic} />
        </section>
        <section id="search">
          <SearchBatchPanel readOnly={false} automatic={automatic} />
        </section>
      </main>
    </>
  )
}
