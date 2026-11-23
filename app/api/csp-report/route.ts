import { withDatabaseRequest } from '@/lib/database/database-context'
import { requireAuth } from '@/lib/identity/auth'
import { jsonBody } from '@/lib/http'
import { route } from '@/lib/route'

export const POST = withDatabaseRequest(
  route(async (req: Request) => {
    await requireAuth()
    const body = await jsonBody(req, 8192)
    const report = body['csp-report']
    if (report && typeof report === 'object') {
      const directive = (report as Record<string, unknown>)['effective-directive']
      if (
        [
          'script-src-elem',
          'script-src-attr',
          'script-src',
          'object-src',
          'base-uri',
          'default-src',
          'img-src',
          'media-src',
          'connect-src',
          'style-src-elem',
          'style-src-attr',
          'font-src',
          'worker-src',
          'frame-src',
          'form-action',
        ].includes(String(directive))
      )
        console.warn('[csp-report]')
    }
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  }),
)
