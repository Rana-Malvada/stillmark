import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc'
import { detectResources, envDetector } from '@opentelemetry/resources'
import { uploadQueuePool } from './upload-queue-database'
import { uploadActiveOperations } from './upload-capacity'
import { flagOn } from '../flags'

let provider: MeterProvider | undefined
export function startUploadQueueMetrics() {
  if (
    provider ||
    process.env.UPLOAD_SERVICE_ONLY !== 'true' ||
    !flagOn('UPLOAD_QUEUE_METRICS_ENABLED')
  )
    return
  if (!process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) {
    console.error(
      '[upload-metrics] Collector endpoint unavailable; no idle measurements will be emitted',
    )
    return
  }
  provider = new MeterProvider({
    // Snowflake injects pod/container identity in OTEL_RESOURCE_ATTRIBUTES.
    // MeterProvider alone does not run resource detection; without this the
    // collector cannot associate measurements with the service being scaled.
    resource: detectResources({ detectors: [envDetector] }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 30000,
        exportTimeoutMillis: 10000,
      }),
    ],
  })
  const meter = provider.getMeter('stillmark.upload')
  const ready = meter.createObservableGauge('stillmark.upload.ready')
  const outstanding = meter.createObservableGauge('stillmark.upload.outstanding')
  const oldest = meter.createObservableGauge('stillmark.upload.oldest_wait_seconds')
  const active = meter.createObservableGauge('stillmark.upload.local_active')
  const failed = meter.createObservableGauge('stillmark.upload.failed_last_hour')
  let lastError = 0
  meter.addBatchObservableCallback(
    async (result) => {
      try {
        const { rows } = await uploadQueuePool().query(`SELECT
        count(*) FILTER (WHERE state='queued' AND next_attempt<=now())::int AS ready,
        count(*) FILTER (WHERE state IN ('queued','processing'))::int AS outstanding,
        coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE state='queued' AND next_attempt<=now())),0)::float8 AS oldest,
        count(*) FILTER (WHERE state='failed')::int AS failed
        FROM upload_processing_jobs WHERE state IN ('queued','processing')
          OR (state='failed' AND failed_at>now()-interval '1 hour')`)
        const row = rows[0]
        for (const value of [row.ready, row.outstanding, row.oldest, row.failed])
          if (!Number.isFinite(value) || value < 0) throw Error('Invalid queue metrics')
        result.observe(ready, row.ready)
        result.observe(outstanding, row.outstanding)
        result.observe(oldest, row.oldest)
        result.observe(active, uploadActiveOperations())
        result.observe(failed, row.failed)
      } catch {
        // Missing measurements are not zero load. Omit all gauges on a failed read.
        if (Date.now() - lastError > 300000) {
          console.error('[upload-metrics] Queue measurement unavailable')
          lastError = Date.now()
        }
      }
    },
    [ready, outstanding, oldest, active, failed],
  )
}
