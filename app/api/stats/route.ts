import { readGalleryStatistics } from '@/lib/gallery-statistics'
import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAdminRead } from '@/lib/identity/auth'
import { privateJson, route } from '@/lib/route'
import { listExhaustedAiPhotos } from '@/lib/gallery-status'

export const dynamic = 'force-dynamic'

export const GET = withDatabaseRequest(
  route({ tag: 'stats' }, async () => {
    await requireAdminRead()
    const row = await readGalleryStatistics()
    const failed_photos = Number(row.photos_failed) > 0 ? await listExhaustedAiPhotos() : []
    return privateJson({ ...row, failed_photos, failures_limit: 50 })
  }),
)
