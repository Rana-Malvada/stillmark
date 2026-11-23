import { diagnosticCode } from './diagnostic-schema'
import { recordPerformance } from './observability/performance-metrics'
/** Observe server-side stream completion without buffering or retrying a body.
 * This measures delivery into the server response stream, not browser rendering. */
export function observeResponseBody(response: Response, state: { id: string; route: string }) {
  if (!response.body) return response
  const reader = response.body.getReader()
  const start = performance.now()
  let finished = false
  const finish = (outcome: 'complete' | 'cancelled' | 'failed', error?: unknown) => {
    if (finished) return
    finished = true
    recordPerformance(`body:${state.route}`, performance.now() - start, 0, outcome !== 'complete')
    if (outcome !== 'complete')
      console.warn('[request-phase]', {
        ...state,
        phase: 'response-body',
        elapsedMs: performance.now() - start,
        code: outcome === 'cancelled' ? 'ABORT_ERR' : (diagnosticCode(error) ?? 'OTHER'),
      })
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await reader.read()
          if (result.done) {
            finish('complete')
            reader.releaseLock()
            controller.close()
          } else controller.enqueue(result.value)
        } catch (error) {
          finish('failed', error)
          reader.releaseLock()
          controller.error(error)
        }
      },
      async cancel(reason) {
        finish('cancelled')
        try {
          await reader.cancel(reason)
        } finally {
          reader.releaseLock()
        }
      },
    },
    { highWaterMark: 0 },
  )
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
