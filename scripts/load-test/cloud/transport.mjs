/** Explicit generator transport; never changes workload deadlines, retries or identity. */
export async function createGeneratorTransport(origin, env = process.env, { ca } = {}) {
  const mode = env.LOAD_TEST_HTTP_PROTOCOL ?? 'native'
  if (!['native', 'h1', 'h2'].includes(mode)) throw Error('Invalid generator HTTP protocol')
  const target = new URL(origin).origin
  if (mode === 'native')
    return { fetch: globalThis.fetch, configuration: { mode }, close: async () => {} }
  const bounded = (name, fallback, max) => {
    const raw = env[name] ?? String(fallback)
    if (
      !/^[0-9]+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < 1 ||
      Number(raw) > max
    )
      throw Error(`Invalid ${name}`)
    return Number(raw)
  }
  const connections = bounded('LOAD_TEST_HTTP_CONNECTIONS', mode === 'h2' ? 8 : 640, 1024)
  const streams = bounded('LOAD_TEST_HTTP_STREAMS', 100, 1024)
  const { Agent, buildConnector } = await import('undici')
  const connector = buildConnector({ allowH2: mode === 'h2', ca })
  const agent = new Agent({
    connections,
    // Undici's dispatcher limit also applies to HTTP/2 streams. A value of
    // one silently serializes each connection regardless of stream settings.
    pipelining: mode === 'h2' ? streams : 1,
    connect(options, callback) {
      return connector(options, (error, socket) => {
        if (!error && mode === 'h2' && socket.alpnProtocol !== 'h2') {
          socket.destroy()
          callback(new Error('HTTP/2 diagnostic requires negotiated h2'))
          return
        }
        callback(error, socket)
      })
    },
    allowH2: mode === 'h2',
    maxConcurrentStreams: streams,
    connectTimeout: 10000,
  })
  return {
    configuration: { mode, connections, streams: mode === 'h2' ? streams : 1 },
    fetch(input, init) {
      // Do not send workload credentials to a different origin or follow redirects.
      if (
        new URL(typeof input === 'string' || input instanceof URL ? input : input.url).origin !==
        target
      )
        throw Error('Generator transport origin mismatch')
      // Keep native FormData/Blob encoding; mixing fetch implementations changes brands.
      return globalThis.fetch(input, { ...init, dispatcher: agent, redirect: 'error' })
    },
    close: () => agent.close(),
  }
}
