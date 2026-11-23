const CARTO = 'https://basemaps.cartocdn.com'

// Snowflake's enforced CSP follows EAI configuration, but its independently
// injected report-only baseline can still flag allowed map tiles. Narrowly align
// image reporting; never change enforcement or the app's violation reporting.
// The exact legacy self-only reporting baseline also flags valid nonced scripts
// and inline styles. Omit that redundant baseline when enforced app reporting exists.
/** @param {Headers} headers */
export function alignMapReportPolicy(headers) {
  if (!headers.get('content-type')?.toLowerCase().includes('text/html')) return
  if (!headers.get('content-security-policy')?.includes(CARTO)) return
  const policy = headers.get('content-security-policy-report-only')
  if (!policy) return
  const aligned = policy
    .split(',')
    .map((part) => {
      if (!/\/sfc-endpoint\/csp-report(?:[;\s]|$)/.test(part)) return part
      const directives = part.split(';')
      const nonempty = directives.map((d) => d.trim()).filter(Boolean)
      const legacyBaseline =
        nonempty.includes("default-src 'self'") &&
        nonempty.includes('report-uri /sfc-endpoint/csp-report') &&
        nonempty.every((d) =>
          [
            "default-src 'self'",
            'report-uri /sfc-endpoint/csp-report',
            'report-to sfc-endpoint-csp-report',
          ].includes(d),
        )
      if (
        legacyBaseline &&
        /(?:^|[;,])\s*report-uri\s+\/api\/csp-report(?:[;,\s]|$)/.test(
          // Present: the enforced policy was matched against CARTO above.
          /** @type {string} */ (headers.get('content-security-policy')),
        )
      )
        return ''
      const image = directives.findIndex((d) => /^\s*img-src(?:\s|$)/i.test(d))
      const fallback = directives.find((d) => /^\s*default-src(?:\s|$)/i.test(d))
      if (image < 0 && !fallback) return part // No image restriction to adjust.
      // One of the two exists; the case where neither does returned above.
      const source = image >= 0 ? directives[image] : /** @type {string} */ (fallback)
      const values = source
        .trim()
        .split(/\s+/)
        .slice(1)
        .filter((v) => v !== "'none'")
      if (!values.includes(CARTO)) values.push(CARTO)
      const allowed = `img-src ${values.join(' ')}`
      if (image >= 0) directives[image] = allowed
      else directives.push(allowed)
      return directives.join(';')
    })
    .filter((part) => part.trim())
    .join(',')
  if (aligned) headers.set('content-security-policy-report-only', aligned)
  else headers.delete('content-security-policy-report-only')
}
