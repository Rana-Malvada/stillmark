// Installed next to the SDK HTTP transport. A single Node module instance owns
// the async context, shared by the app and the externalized SDK in standalone.
const { AsyncLocalStorage } = require('node:async_hooks')
const { setTimeout: delay } = require('node:timers/promises')
const { CanceledError } = require('axios')

const context = new AsyncLocalStorage()

exports.runWithSignal = (signal, work) => context.run(signal, work)
exports.applySignal = (options) => {
  const signal = context.getStore()
  if (signal) options.signal = options.signal ? AbortSignal.any([signal, options.signal]) : signal
}
exports.sleep = async (ms, signal) => {
  try {
    await delay(ms, undefined, { signal })
  } catch (error) {
    if (signal?.aborted) throw new CanceledError('Request deadline expired')
    throw error
  }
}
