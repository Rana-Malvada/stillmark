import test from 'node:test'
import assert from 'node:assert/strict'
import { safeTransportFailure } from './http-failure.mjs'

test('records fixed nested transport codes without private exception data', () => {
  const error = new TypeError('secret URL', {
    cause: Object.assign(new Error('token'), {
      code: 'ECONNRESET',
      socket: { remoteAddress: 'private' },
    }),
  })
  assert.deepEqual(safeTransportFailure(error), {
    name: 'TypeError',
    causeCode: 'ECONNRESET',
    causeName: 'Error',
  })
  assert.deepEqual(
    safeTransportFailure({
      name: 'secret',
      code: 'secret',
      cause: { name: 'private', code: 'private' },
    }),
    {},
  )
  assert.deepEqual(safeTransportFailure(null), {})
})
