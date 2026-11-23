import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  status: vi.fn(async () => 'RUNNING'),
  cancel: vi.fn((cb: () => void) => cb()),
}))
vi.mock('fs', () => ({ default: { readFileSync: () => 'fake-service-token' } }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('snowflake-sdk', () => ({
  default: {
    configure: vi.fn(),
    createPool: () => ({
      use: async (fn: any) =>
        fn({
          execute: state.execute,
          getQueryStatus: state.status,
          isAnError: () => false,
          isStillRunning: () => true,
        }),
    }),
  },
}))
import { querySnowflake, querySnowflakeLongRunning } from '@/lib/snowflake'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
it('sets a server time budget and cancels a query that exceeds the client budget', async () => {
  vi.useFakeTimers()
  vi.stubEnv('SNOWFLAKE_SDK_QUIET', '1')
  state.execute.mockImplementation((options: any) => {
    options.complete(null, { getQueryId: () => 'query-id' })
    return { cancel: state.cancel }
  })
  const pending = querySnowflakeLongRunning('SELECT costly_work()', {
    maxWaitMs: 100,
    pollIntervalMs: 50,
  })
  const rejection = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(250)
  await rejection
  expect(state.execute.mock.calls[0][0].parameters.STATEMENT_TIMEOUT_IN_SECONDS).toBe(1)
  expect(state.cancel).toHaveBeenCalledTimes(1)
})

import { costContext } from '@/lib/costs/cost-context'

it('passes attribution as a statement parameter and clears it on the next pooled request', async () => {
  state.execute.mockReset()
  state.execute.mockImplementation((o: any) => o.complete(null, { getQueryId: () => 'id' }, []))
  await costContext.run('work-id', () => querySnowflake('SELECT 1'))
  await querySnowflake('SELECT 2')
  expect(state.execute.mock.calls[0][0].parameters.QUERY_TAG).toBe('personal-photos:work-id')
  expect(state.execute.mock.calls[1][0].parameters.QUERY_TAG).toBe('')
})

it('cancels an AI statement when its worker loses its claim and refuses pre-aborted work', async () => {
  vi.useFakeTimers()
  state.cancel.mockClear()
  state.execute.mockClear()
  state.execute.mockImplementation((o: any) => {
    o.complete(null, { getQueryId: () => 'cancel-id' })
    return { cancel: state.cancel }
  })
  const controller = new AbortController()
  const pending = querySnowflakeLongRunning('SELECT costly_work()', {
    signal: controller.signal,
    pollIntervalMs: 50,
  })
  const rejected = expect(pending).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(1)
  controller.abort()
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  expect(state.cancel).toHaveBeenCalledTimes(1)
  state.execute.mockClear()
  await expect(
    querySnowflakeLongRunning('SELECT costly_work()', { signal: controller.signal }),
  ).rejects.toThrow()
  expect(state.execute).not.toHaveBeenCalled()
})

it('enforces the total budget while the SDK status request is stalled', async () => {
  vi.useFakeTimers()
  state.execute.mockImplementation((o: any) => {
    o.complete(null, { getQueryId: () => 'stalled-status-id' })
    return { cancel: state.cancel }
  })
  state.status.mockImplementationOnce(() => new Promise<string>(() => {}))
  let settled = false
  const pending = querySnowflakeLongRunning('SELECT costly_work()', {
    maxWaitMs: 100,
    pollIntervalMs: 50,
  })
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await vi.advanceTimersByTimeAsync(250)
  expect(settled).toBe(true)
  await expect(pending).rejects.toThrow(/timed out|deadline/i)
})

import { PassThrough } from 'node:stream'
import { queryWithPoolLongRunning } from '@/lib/snowflake/query-execution'

it.each(['submit', 'status', 'result', 'stream'])(
  'cancels stalled %s and destroys its connection before returning',
  async (stage) => {
    vi.useFakeTimers()
    const order: string[] = []
    const never = () => new Promise<any>(() => {})
    const stream = new PassThrough({ objectMode: true })
    const connection = {
      execute(o: any) {
        if (stage !== 'submit') o.complete(null, { getQueryId: () => 'fault-id' })
        return {
          cancel(cb: () => void) {
            order.push('cancel')
            cb()
          },
        }
      },
      getQueryStatus: stage === 'status' ? never : async () => 'SUCCESS',
      isAnError: () => false,
      isStillRunning: () => false,
      getResultsFromQueryId:
        stage === 'result' ? never : async () => ({ streamRows: () => stream }),
      destroy(cb: () => void) {
        order.push('transport-destroy')
        cb()
      },
    }
    const pool = {
      acquire: async () => connection,
      release: vi.fn(async () => {}),
      destroy: vi.fn(async () => {
        order.push('pool-destroy')
      }),
    }
    const pending = queryWithPoolLongRunning(pool as any, 'SELECT work()', 'test', {
      maxWaitMs: 100,
      pollIntervalMs: 10,
      statusLogIntervalMs: 60000,
    })
    const rejected = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(250)
    await rejected
    expect(order).toEqual(['cancel', 'transport-destroy', 'pool-destroy'])
    expect(pool.release).not.toHaveBeenCalled()
    if (stage === 'stream') expect(stream.destroyed).toBe(true)
  },
)
