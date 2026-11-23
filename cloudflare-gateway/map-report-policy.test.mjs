import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignMapReportPolicy } from './map-report-policy.mjs'

const carto = 'https://basemaps.cartocdn.com'
const enforced = `default-src 'self' ${carto}; script-src 'nonce-test' 'strict-dynamic'`
function headers(report, type = 'text/html', enforcement = enforced) {
  return new Headers({
    'content-type': type,
    'content-security-policy': enforcement,
    'content-security-policy-report-only': report,
  })
}
test('permits only CARTO images in Snowflake reporting while preserving enforcement and reports', () => {
  const h = headers(
    "default-src 'self' blob: data:; script-src 'self'; report-uri /sfc-endpoint/csp-report",
  )
  alignMapReportPolicy(h)
  const result = h.get('content-security-policy-report-only')
  assert.ok(result.endsWith(`img-src 'self' blob: data: ${carto}`))
  assert.ok(result.includes("script-src 'self'"))
  assert.ok(result.includes('report-uri /sfc-endpoint/csp-report'))
  assert.equal(h.get('content-security-policy'), enforced)
  alignMapReportPolicy(h)
  assert.equal(h.get('content-security-policy-report-only'), result)
})
test('handles explicit image restrictions and multiple policies without altering app reporting', () => {
  const app = "default-src 'none'; report-uri /api/csp-report"
  const h = headers(
    `default-src 'none'; img-src 'self'; report-uri /sfc-endpoint/csp-report,${app}`,
  )
  alignMapReportPolicy(h)
  assert.equal(
    h.get('content-security-policy-report-only'),
    `default-src 'none';img-src 'self' ${carto}; report-uri /sfc-endpoint/csp-report,${app}`,
  )
})
test('does not broaden unconfigured, non-HTML, or unrelated reporting policies', () => {
  for (const h of [
    headers("img-src 'none'; report-uri /api/csp-report"),
    headers("default-src 'self'; report-uri /sfc-endpoint/csp-report", 'image/png'),
    headers(
      "default-src 'self'; report-uri /sfc-endpoint/csp-report",
      'text/html',
      "default-src 'self'",
    ),
  ]) {
    const before = [...h]
    alignMapReportPolicy(h)
    assert.deepEqual([...h], before)
  }
})

test('removes only the known redundant Snowflake baseline when app enforcement already reports violations', () => {
  const active = enforced + '; report-uri /api/csp-report'
  const baseline =
    "default-src 'self'; report-uri /sfc-endpoint/csp-report; report-to sfc-endpoint-csp-report;"
  const h = headers(baseline, 'text/html', active)
  alignMapReportPolicy(h)
  assert.equal(h.get('content-security-policy-report-only'), null)
  assert.equal(h.get('content-security-policy'), active)
  const custom = "script-src 'self'; report-uri /api/csp-report"
  const combined = headers(`${baseline},${custom}`, 'text/html', active)
  alignMapReportPolicy(combined)
  assert.equal(combined.get('content-security-policy-report-only'), custom)
  assert.equal(combined.get('content-security-policy'), active)
})

test('preserves unfamiliar Snowflake restrictions and baseline reporting when app reporting is absent', () => {
  const baseline = "default-src 'self'; report-uri /sfc-endpoint/csp-report;"
  const h = headers(baseline)
  alignMapReportPolicy(h)
  assert.ok(
    h.get('content-security-policy-report-only').includes('report-uri /sfc-endpoint/csp-report'),
  )
  const stricter = headers(
    baseline + ' script-src https://trusted.example',
    'text/html',
    enforced + '; report-uri /api/csp-report',
  )
  alignMapReportPolicy(stricter)
  assert.ok(
    stricter
      .get('content-security-policy-report-only')
      .includes('script-src https://trusted.example'),
  )
})
