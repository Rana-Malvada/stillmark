import { channel } from 'node:diagnostics_channel'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { beginLoadTestHttp } from './load-test-request-journal'

let installed = false
const sockets = new WeakMap<Socket, { firstObservedAt: number; requests: number }>()
/** Isolated diagnostics only. No bodies, URLs, identities or socket data retained. */
export function installLoadTestHttpLifecycle() {
  if (
    installed ||
    process.env.UPLOAD_REQUEST_TRACE !== 'true' ||
    !/^stillmark_loadtest_[a-z0-9_]+$/.test(process.env.PG_DATABASE ?? '')
  )
    return
  installed = true
  channel('http.server.request.start').subscribe((message) => {
    try {
      const { request, response } = message as {
        request: IncomingMessage
        response: ServerResponse
      }
      const id = request.headers['x-load-test-request']
      if (typeof id !== 'string') return
      const attempt = beginLoadTestHttp(id)
      if (!attempt) return
      const socket = request.socket
      const state = sockets.get(socket) ?? { firstObservedAt: Date.now(), requests: 0 }
      sockets.set(socket, state)
      const evidence = (attempt.socket = {
        firstObservedAt: state.firstObservedAt,
        requestNumber: ++state.requests,
        timeoutMs: socket.timeout ?? 0,
      }) as NonNullable<typeof attempt.socket>
      // Observe only the active response, not every later use of this socket.
      // No addresses, headers, tokens, or exception messages are retained.
      const timeout = () => {
        evidence.timeoutAt = Date.now()
      }
      const ended = () => {
        evidence.peerEndedAt = Date.now()
      }
      const error = (err: Error & { code?: string }) => {
        evidence.errorCode = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(err.code ?? '')
          ? err.code
          : 'OTHER'
      }
      const cleanup = () => {
        socket.off('timeout', timeout)
        socket.off('end', ended)
        socket.off('error', error)
        socket.off('close', closed)
      }
      const closed = (hadError: boolean) => {
        evidence.closedAt = Date.now()
        evidence.hadError = hadError
        cleanup()
      }
      socket.once('timeout', timeout)
      socket.once('end', ended)
      socket.once('error', error)
      socket.once('close', closed)
      response.once('finish', () => {
        attempt.finishedAt = Date.now()
        attempt.status = response.statusCode
        attempt.completed = response.writableFinished
        cleanup()
      })
      response.once('close', () => {
        attempt.closedAt = Date.now()
        attempt.completed = response.writableFinished
      })
    } catch {
      /* Diagnostics must not affect responses. */
    }
  })
}
