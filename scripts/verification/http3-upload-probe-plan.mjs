export const PROBE_ORIGIN = 'https://stillmark-loadtest-baseline.02-zoom-netbook.workers.dev'
export const PROBE_WORKER = 'stillmark-loadtest-baseline'
export const RESTORE_VERSION = '788ba623-25d7-4ffa-abc9-0b50700bd076'
export const WINDOW_MS = 6 * 60 * 1000
export const MAX_BODY = 8 * 1024 * 1024 + 64 * 1024
export const MAX_PLAN_BYTES = 48 * 1024 * 1024
export const BASE_PATH = '/__upload_probe__'
export const BOUNDARY = 'stillmark-synthetic-probe-boundary'
export const PREFIX = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="chunk"; filename="synthetic.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
export const SUFFIX = `\r\n--${BOUNDARY}--\r\n`

const cases = [
  ['drain', 2097152, 'multipart', 'drain'],
  ['buffer', 2097152, 'multipart', 'buffer'],
  ['reject', 2097152, 'multipart', 'early rejection'],
  ['drain', 2097152, 'multipart', 'after rejection'],
  ...Array.from({ length: 4 }, () => ['buffer', 2097152, 'multipart', 'four concurrent']),
  ['abort', 2097152, 'multipart', 'intentional client abort'],
  ['drain', 2097152, 'raw', 'final control'],
]

// Twenty distinct attempts across both lanes; no automatic retries.
export const PLAN = ['h2', 'h3'].flatMap((lane, laneIndex) =>
  cases.map(([mode, payloadBytes, format, label], index) => ({
    slot: laneIndex * 10 + index + 1,
    lane,
    mode,
    payloadBytes,
    format,
    label,
    wireBytes: payloadBytes + (format === 'multipart' ? PREFIX.length + SUFFIX.length : 0),
  })),
)

export const PLAN_BYTES = PLAN.reduce((sum, item) => sum + item.wireBytes, 0)
if (PLAN.length !== 20 || PLAN_BYTES > MAX_PLAN_BYTES || PLAN.some((p) => p.wireBytes > MAX_BODY))
  throw Error('Invalid synthetic upload plan')
