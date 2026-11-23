import { observeResponseBody } from './response-body-observation'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { diagnosticCode, phases } from './diagnostic-schema'
import { recordPerformance } from './observability/performance-metrics'

const context = new AsyncLocalStorage<{ id: string; route: string }>()
export function withoutRequestObservation<T>(fn: () => T): T {
  return context.exit(fn)
}
function routeClass(path: string) {
  if (path === '/api/images' || /^\/share\/[^/]+\/media\//.test(path)) return 'media'
  for (const [prefix, label] of [
    ['events', 'albums'],
    ['photos', 'photos'],
    ['search', 'search'],
    ['people', 'people'],
    ['travels', 'travels'],
  ]) {
    if (path === `/api/${prefix}` || path.startsWith(`/api/${prefix}/`)) return label
  }
  return 'other'
}
export async function observeRequest<T extends Response>(
  request: Request,
  work: () => Promise<T>,
): Promise<T> {
  if (context.getStore()) return work()
  const supplied = request.headers.get('x-photo-request-id') ?? ''
  const state = {
    id: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(supplied)
      ? supplied
      : randomUUID(),
    route: routeClass(new URL(request.url).pathname),
  }
  const started = performance.now()
  let status = 500
  try {
    return await context.run(state, async () => {
      const response = await work()
      status = response.status
      response.headers.set('X-Request-ID', state.id)
      return (state.route === 'media' ? observeResponseBody(response, state) : response) as T
    })
  } finally {
    const elapsedMs = performance.now() - started
    recordPerformance(`headers:${state.route}`, elapsedMs, 0, status >= 500)
    if (status >= 500 || elapsedMs >= 1000)
      console.warn('[request-headers]', { ...state, elapsedMs, status })
  }
}
export async function observePhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  const state = context.getStore()
  if (!state || !phases.has(phase)) return work()
  const started = performance.now()
  let failed = false
  try {
    return await work()
  } catch (error) {
    failed = true
    console.error('[request-phase]', {
      ...state,
      phase,
      elapsedMs: performance.now() - started,
      code: diagnosticCode(error) ?? 'OTHER',
    })
    throw error
  } finally {
    recordPerformance(`phase:${phase}`, performance.now() - started, 0, failed)
  }
}
