import { beforeEach, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  callback: undefined as
    undefined | ((result: { observe: ReturnType<typeof vi.fn> }) => Promise<void>),
  active: vi.fn(() => 0),
  exporter: vi.fn(),
  provider: vi.fn(),
}))
vi.mock('../lib/upload/upload-queue-database', () => ({
  uploadQueuePool: () => ({ query: mocks.query }),
}))
vi.mock('../lib/upload/upload-capacity', () => ({ uploadActiveOperations: mocks.active }))
vi.mock('@opentelemetry/exporter-metrics-otlp-grpc', () => ({
  OTLPMetricExporter: class {
    constructor() {
      mocks.exporter()
    }
  },
}))
vi.mock('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: class {},
  MeterProvider: class {
    constructor(options: unknown) {
      mocks.provider(options)
    }
    getMeter() {
      return {
        createObservableGauge: (s: string) => s,
        addBatchObservableCallback: (cb: typeof mocks.callback) => {
          mocks.callback = cb
        },
      }
    }
  },
}))
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.callback = undefined
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'true')
  vi.stubEnv('UPLOAD_QUEUE_METRICS_ENABLED', 'true')
  vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'http://collector:4317')
})
it('preserves injected container identity for service-scoped scaling', async () => {
  vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'k8s.pod.uid=test-pod,snow.service.container.name=upload')
  ;(await import('../lib/upload/upload-queue-metrics')).startUploadQueueMetrics()
  expect(mocks.provider.mock.calls[0][0].resource.attributes).toMatchObject({
    'k8s.pod.uid': 'test-pod',
    'snow.service.container.name': 'upload',
  })
})
it('does not export from the app server or while disabled', async () => {
  vi.stubEnv('UPLOAD_SERVICE_ONLY', 'false')
  ;(await import('../lib/upload/upload-queue-metrics')).startUploadQueueMetrics()
  expect(mocks.exporter).not.toHaveBeenCalled()
})
it('uses one global aggregate and has no identity labels', async () => {
  mocks.query.mockResolvedValue({ rows: [{ ready: 4, outstanding: 7, oldest: 31, failed: 3 }] })
  mocks.active.mockReturnValue(2)
  const { startUploadQueueMetrics } = await import('../lib/upload/upload-queue-metrics')
  startUploadQueueMetrics()
  startUploadQueueMetrics()
  const observe = vi.fn()
  await mocks.callback!({ observe })
  expect(mocks.exporter).toHaveBeenCalledTimes(1)
  expect(mocks.query).toHaveBeenCalledTimes(1)
  expect(observe.mock.calls).toEqual([
    ['stillmark.upload.ready', 4],
    ['stillmark.upload.outstanding', 7],
    ['stillmark.upload.oldest_wait_seconds', 31],
    ['stillmark.upload.local_active', 2],
    ['stillmark.upload.failed_last_hour', 3],
  ])
})
it('never publishes fake idle when the database fails or returns invalid values', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ;(await import('../lib/upload/upload-queue-metrics')).startUploadQueueMetrics()
  const observe = vi.fn()
  mocks.query.mockRejectedValueOnce(Error('offline'))
  await mocks.callback!({ observe })
  mocks.query.mockResolvedValueOnce({
    rows: [{ ready: NaN, outstanding: 0, oldest: 0, failed: 0 }],
  })
  await mocks.callback!({ observe })
  expect(observe).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})
it('counts terminal failures separately from scaling backlog using the real queue query', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE SCHEMA photo_security;
      CREATE TABLE upload_processing_jobs(state text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),next_attempt timestamptz DEFAULT now());
      INSERT INTO upload_processing_jobs(state) VALUES('failed'),('failed'),('failed'),('queued'),('processing'),('done');
      INSERT INTO upload_processing_jobs(state,updated_at) VALUES('failed',now()-interval '2 hours');`)
    await db.exec(
      readFileSync('migrations/postgres/202611081520_upload_failure_timestamp.sql', 'utf8'),
    )
    mocks.query.mockImplementation((sql: string) => db.query(sql))
    ;(await import('../lib/upload/upload-queue-metrics')).startUploadQueueMetrics()
    const observe = vi.fn()
    await mocks.callback!({ observe })
    expect(observe).toHaveBeenCalledWith('stillmark.upload.ready', 1)
    expect(observe).toHaveBeenCalledWith('stillmark.upload.outstanding', 2)
    expect(observe).toHaveBeenCalledWith('stillmark.upload.failed_last_hour', 3)
  } finally {
    await db.close()
  }
})
