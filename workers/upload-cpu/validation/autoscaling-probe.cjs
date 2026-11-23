// Isolated controller test only. Never run as the production upload entrypoint.
// No catalog credentials, stage access, HTTP endpoint or media processing.
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics')
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc')
const { detectResources, envDetector } = require('@opentelemetry/resources')

const loadEnd = Number(process.env.VALIDATE_LOAD_END_MS)
const drainEnd = loadEnd + 60000
if (
  !Number.isSafeInteger(loadEnd) ||
  loadEnd < Date.now() - 1800000 ||
  loadEnd > Date.now() + 900000
)
  throw Error('Bounded absolute test schedule required')
const provider = new MeterProvider({
  resource: detectResources({ detectors: [envDetector] }),
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 30000,
      exportTimeoutMillis: 10000,
    }),
  ],
})
const meter = provider.getMeter('stillmark.upload.autoscaling-validation')
const gauges = ['ready', 'outstanding', 'oldest_wait_seconds', 'local_active'].map((name) =>
  meter.createObservableGauge('stillmark.upload.' + name),
)
let previous
meter.addBatchObservableCallback((result) => {
  const phase = Date.now() < loadEnd ? 'backlog' : Date.now() < drainEnd ? 'draining' : 'idle'
  const values =
    phase === 'backlog' ? [40, 40, 60, 1] : phase === 'draining' ? [0, 1, 0, 1] : [0, 0, 0, 0]
  gauges.forEach((g, i) => result.observe(g, values[i]))
  if (phase !== previous) {
    console.log(
      JSON.stringify({
        test: 'autoscaling-controller',
        phase,
        at: new Date().toISOString(),
        loadEnd,
        drainEnd,
      }),
    )
    previous = phase
  }
}, gauges)
// The operator removes the service/pool; this bounds an accidentally abandoned probe.
setTimeout(
  async () => {
    await provider.shutdown()
    process.exit(0)
  },
  Math.max(1000, drainEnd + 1800000 - Date.now()),
)
