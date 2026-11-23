import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'

const scope = new AsyncLocalStorage()
const requests = new WeakMap()
const sockets = new WeakMap()
let nextSocket = 0
const events = {
  'undici:request:create': 'createdMs',
  'undici:client:sendHeaders': 'sentHeadersMs',
  'undici:request:bodySent': 'bodySentMs',
  'undici:request:headers': 'responseHeadersMs',
  'undici:request:trailers': 'responseCompleteMs',
  'undici:request:error': 'transportErrorMs',
}
let installed = false
const emptyMetrics = Object.freeze({})
const inactiveTrace = Object.freeze({ run: (work) => work(), finish: () => emptyMetrics })
function installTracing() {
  if (installed) return
  installed = true
  for (const [name, field] of Object.entries(events)) {
    channel(name).subscribe(({ request, socket, error }) => {
      if (name === 'undici:request:create' && scope.getStore())
        requests.set(request, scope.getStore())
      const state = requests.get(request)
      if (!state || state.closed) return
      state.metrics[field] = performance.now() - state.started
      if (name === 'undici:request:trailers' && state.connection)
        state.connection.lastCompleted = performance.now()
      if (
        name === 'undici:request:error' &&
        [
          'UND_ERR_SOCKET',
          'UND_ERR_CONNECT_TIMEOUT',
          'UND_ERR_HEADERS_TIMEOUT',
          'UND_ERR_BODY_TIMEOUT',
          'ECONNRESET',
          'ECONNREFUSED',
          'EPIPE',
          'ETIMEDOUT',
          'ENOTFOUND',
          'EAI_AGAIN',
          'ABORT_ERR',
        ].includes(error?.code)
      )
        state.metrics.errorCode = error.code
      if (socket) {
        if (['h2', 'http/1.1'].includes(socket.alpnProtocol))
          state.metrics.protocol = socket.alpnProtocol
        let connection = sockets.get(socket)
        if (!connection) {
          connection = { id: ++nextSocket, created: performance.now(), count: 0 }
          sockets.set(socket, connection)
          // One listener per connection, not per request. Retain no payloads.
          for (const event of ['end', 'close', 'error']) {
            socket.on(event, () => {
              for (const active of connection.active ?? [])
                active.metrics[`socket${event[0].toUpperCase() + event.slice(1)}Ms`] =
                  performance.now() - active.started
            })
          }
          connection.active = new Set()
        }
        state.connection = connection
        state.socket = socket
        state.readAtSend = socket.bytesRead
        state.writtenAtSend = socket.bytesWritten
        connection.active.add(state)
        if (connection.lastCompleted !== undefined)
          state.metrics.socketIdleMs = performance.now() - connection.lastCompleted
        state.metrics.socketId = connection.id
        state.metrics.socketRequest = ++connection.count
        state.metrics.socketAgeMs = performance.now() - connection.created
      }
    })
  }
}
/** Only numeric lifecycle timings and allowlisted error codes; never retain headers, URLs, sockets or error messages. */
export function transportTrace({
  enabled = process.env.LOAD_TEST_TRANSPORT_TRACE !== 'false',
} = {}) {
  if (!enabled) return inactiveTrace
  installTracing()
  const state = { metrics: {}, started: performance.now(), closed: false }
  return {
    run: (work) => scope.run(state, work),
    finish: () => {
      state.closed = true
      if (state.socket) {
        state.metrics.socketBytesRead = state.socket.bytesRead - state.readAtSend
        state.metrics.socketBytesWritten = state.socket.bytesWritten - state.writtenAtSend
        state.metrics.socketDestroyed = Number(state.socket.destroyed)
        state.connection.active.delete(state)
        state.socket = null
        state.connection = null
      }
      return { ...state.metrics }
    },
  }
}
