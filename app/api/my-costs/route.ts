import { withDatabaseRequest } from '@/lib/database/database-context'
import { albumCaller } from '@/lib/albums/album-access'
import { personalCosts } from '@/lib/costs/personal-costs'
import { privateJson, route } from '@/lib/route'

export const dynamic = 'force-dynamic'
export const GET = withDatabaseRequest(
  route(async (req: Request) => {
    const caller = await albumCaller()
    return privateJson(await personalCosts(caller, new URL(req.url).searchParams.get('user')))
  }),
)
