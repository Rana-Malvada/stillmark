import { deployment, objects } from '../config/deployment.mjs'
// Read-only by default. --apply fills missing catalog fields from a saved scan.
import fs from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { execFileSync } from 'node:child_process'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './video-date') specifier = './video-date.ts'
    return next(specifier, context)
  },
})
const { videoMetadata } = await import('../lib/video/video-metadata.ts')
const dir = path.resolve(
  process.argv.find((v) => v.startsWith('--dir='))?.slice(6) ??
    '.deployment-backups/video-metadata-20261003',
)
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const sql = (q) =>
  execFileSync(
    '/opt/homebrew/opt/libpq/bin/psql',
    [`service=${deployment.PG_SERVICE}`, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', q],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  )
const fields = [
  'latitude',
  'longitude',
  'altitude',
  'camera_make',
  'camera_model',
  'software',
  'width',
  'height',
  'aspect_ratio',
  'date_taken',
  'date_taken_raw',
  'exif_raw',
]
const quote = (v) => (v == null ? 'NULL' : "'" + String(v).replaceAll("'", "''") + "'")
if (process.argv.includes('--apply')) {
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'scan.json'), 'utf8'))
  const updates = []
  // Per row compare-and-swap: preserve changes made since the scan, including manually set locations.
  for (const r of report.results) {
    if (!r.metadata) continue
    const m = r.metadata
    const b = r.before
    const patch = {}
    if (b.latitude == null && b.longitude == null && m.latitude != null && m.longitude != null) {
      patch.latitude = m.latitude
      patch.longitude = m.longitude
      if (b.altitude == null && m.altitude != null) patch.altitude = m.altitude
    }
    for (const [db, key] of [
      ['camera_make', 'cameraMake'],
      ['camera_model', 'cameraModel'],
      ['software', 'software'],
      ['width', 'width'],
      ['height', 'height'],
    ])
      if (b[db] == null && m[key] != null) patch[db] = m[key]
    if (b.aspect_ratio == null && m.width && m.height && b.width == null && b.height == null)
      patch.aspect_ratio = m.width / m.height
    if (b.date_taken == null && m.capture) {
      patch.date_taken = m.capture.date
      if (b.date_taken_raw == null) patch.date_taken_raw = m.capture.raw
    }
    if (!Object.keys(patch).length) continue
    const set = Object.entries(patch).map(([k, v]) => `${k}=${quote(v)}`)
    set.push(
      `exif_raw=COALESCE(exif_raw,'{}'::jsonb)||${quote(JSON.stringify({ videoMetadataVersion: 1, videoTags: m.tags }))}::jsonb`,
      'updated_at=NOW()',
    )
    const conditions = fields.map(
      (k) =>
        `${k} IS NOT DISTINCT FROM ${k === 'exif_raw' ? quote(b[k] == null ? null : JSON.stringify(b[k])) + '::jsonb' : quote(b[k])}`,
    )
    updates.push(
      `UPDATE photos SET ${set.join(',')} WHERE photo_id=${Number(r.id)} AND media_type='video' AND ${conditions.join(' AND ')} RETURNING photo_id;`,
    )
  }
  const output = execFileSync(
    '/opt/homebrew/opt/libpq/bin/psql',
    [`service=${deployment.PG_SERVICE}`, '-X', '-v', 'ON_ERROR_STOP=1', '-At'],
    {
      input: 'BEGIN;\n' + updates.join('\n') + '\nCOMMIT;',
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  )
  const updated = (output.match(/^\d+$/gm) ?? []).length
  fs.writeFileSync(
    path.join(dir, 'applied.json'),
    JSON.stringify({ updated, at: new Date().toISOString() }),
    { mode: 0o600 },
  )
  console.log(JSON.stringify({ updated }))
  process.exit(0)
}
const rows = JSON.parse(
  sql(
    `SELECT COALESCE(json_agg(t),'[]') FROM (SELECT photo_id,original_stage_path,file_size_bytes,${fields.join(',')} FROM photos WHERE media_type='video' ORDER BY photo_id) t`,
  ),
)
fs.writeFileSync(path.join(dir, 'before.json'), JSON.stringify(rows), { mode: 0o600 })
const sfQuote = (v) => "'" + String(v).replaceAll('\\', '\\\\').replaceAll("'", "''") + "'"
const query = `SELECT column1 AS ID, GET_PRESIGNED_URL(@${objects.originals},column2,3600) AS URL FROM VALUES ${rows.map((r) => `(${Number(r.photo_id)},${sfQuote(r.original_stage_path)})`).join(',')};`
const queryFile = path.join(dir, 'urls.sql')
fs.writeFileSync(queryFile, query, { mode: 0o600 })
const signed = JSON.parse(
  execFileSync(
    '/opt/homebrew/bin/snow',
    ['sql', '-c', deployment.CLI_CONNECTION, '-f', queryFile, '--format', 'json'],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  ),
)
fs.unlinkSync(queryFile)
const urls = new Map(signed.map((r) => [Number(r.ID), r.URL]))
const results = []
let index = 0
async function worker() {
  while (index < rows.length) {
    const row = rows[index++]
    try {
      const size = Number(row.file_size_bytes)
      const url = urls.get(Number(row.photo_id))
      if (!url) throw Error('No original URL')
      const metadata = await videoMetadata(async (offset, length) => {
        const response = await fetch(url, {
          headers: { Range: `bytes=${offset}-${offset + length - 1}` },
          signal: AbortSignal.timeout(30000),
        })
        if (
          response.status !== 206 ||
          response.headers.get('content-range') !== `bytes ${offset}-${offset + length - 1}/${size}`
        ) {
          await response.body?.cancel()
          throw Error(`Original range unavailable (${response.status})`)
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length !== length) throw Error('Truncated metadata')
        return buffer
      }, size)
      results.push({ id: row.photo_id, before: row, metadata })
    } catch (e) {
      results.push({
        id: row.photo_id,
        error: e.name === 'TimeoutError' ? 'Metadata read timed out' : 'Metadata read failed',
      })
    }
    if (results.length % 50 === 0)
      console.log(
        JSON.stringify({
          scanned: results.length,
          gps: results.filter((r) => r.metadata?.latitude != null).length,
          errors: results.filter((r) => r.error).length,
        }),
      )
  }
}
await Promise.all([worker(), worker(), worker()])
fs.writeFileSync(path.join(dir, 'scan.json'), JSON.stringify({ results }, null, 2), { mode: 0o600 })
console.log(
  JSON.stringify({
    scanned: results.length,
    gps: results.filter((r) => r.metadata?.latitude != null).length,
    camera: results.filter((r) => r.metadata?.cameraModel).length,
    dimensions: results.filter((r) => r.metadata?.width).length,
    errors: results.filter((r) => r.error).length,
  }),
)
