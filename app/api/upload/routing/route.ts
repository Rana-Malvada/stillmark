import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireUploadUser } from '@/lib/albums/album-access'
import { requireSameOrigin } from '@/lib/identity/auth'
import { readUploadRoutingPhase, requestUploadMode } from '@/lib/upload/upload-routing'
import { HttpError } from '@/lib/http'
import { privateJson, route } from '@/lib/route'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async () => {
    await requireUploadUser()
    const phase = await readUploadRoutingPhase()
    if (!phase) throw new HttpError(503, 'Upload routing unavailable', 2)
    return privateJson({ route: 'pool', phase, ready: phase === 'pool' })
  }),
)
export const POST = withDatabaseRequest(
  route(async () => {
    const user = await requireUploadUser()
    await requireSameOrigin()
    const state = await requestUploadMode('pool', user.username)
    return privateJson({ route: 'pool', phase: state.phase, ready: state.phase === 'pool' })
  }),
)
