import { withDatabaseRequest } from '@/lib/database/database-context'
import { withBrowseRequest } from '@/lib/browse-request'
import { requireUploadUser } from '@/lib/albums/album-access'
import { trackAction } from '@/lib/observability/activity-action'
import { requireAuth, requireSameOrigin } from '@/lib/identity/auth'
import { jsonBody, PRIVATE_NO_STORE } from '@/lib/http'
import { privateJson, route } from '@/lib/route'

type Params = Promise<Record<string, string>>
const PRIVATE_ERRORS = { errorHeaders: PRIVATE_NO_STORE }

/** Signed-in read; row security decides what is visible. */
export function peopleRead(fn: (req: Request, params: Record<string, string>) => Promise<unknown>) {
  const bounded = withBrowseRequest(
    route(PRIVATE_ERRORS, async (req: Request, ctx: { params: Params }) => {
      await requireAuth()
      return privateJson(await fn(req, (await ctx?.params) ?? {}))
    }),
  )
  return async (req: Request, ctx: { params: Params }) => {
    const response = await bounded(req, ctx)
    // The deadline and upload-service guard can return before the handler does.
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }
}

/**
 * Same-origin write by a user who manages their own library. Activity records only
 * the kind of change, never names or faces.
 */
export function peopleWrite(
  action: string | ((body: Record<string, unknown>) => string),
  fn: (body: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>,
  { body: needsBody = true } = {},
) {
  return withDatabaseRequest(
    route(PRIVATE_ERRORS, async (req: Request, ctx: { params: Params }) => {
      await requireSameOrigin()
      await requireUploadUser()
      const body = needsBody ? await jsonBody(req) : {}
      const result = await fn(body, (await ctx?.params) ?? {})
      trackAction('people_changed', '', {
        mode: typeof action === 'string' ? action : action(body),
      })
      return privateJson(result)
    }),
  )
}
