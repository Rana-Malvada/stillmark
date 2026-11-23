/** Manual recovery only: retain the original cutoff, refresh only transport authentication. */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const fields = ['attempts', 'changedAt', 'event', 'issuer', 'subject', 'version']
export function credentialReplay(
  record,
  { origin, issuer, key, now = Math.floor(Date.now() / 1000) },
) {
  const target = new URL(origin)
  if (
    target.protocol !== 'https:' ||
    target.pathname !== '/' ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  )
    throw Error('Invalid recovery origin')
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).sort().join(',') !== fields.join(',') ||
    record.event !== 'stillmark_credential_delivery_failed' ||
    record.version !== 1 ||
    record.attempts !== 3 ||
    typeof issuer !== 'string' ||
    record.issuer !== issuer ||
    typeof record.subject !== 'string' ||
    !record.subject.startsWith('auth0|') ||
    record.subject.length > 200 ||
    /[\x00-\x1f]/.test(record.subject) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(record.changedAt) ||
    record.changedAt < 1 ||
    record.changedAt > now + 5
  )
    throw Error('Invalid original credential failure record')
  const body = JSON.stringify({
    issuer: record.issuer,
    subject: record.subject,
    changedAt: record.changedAt,
  })
  const preview = {
    mode: 'dry-run',
    target: target.origin + '/auth/credential-change',
    changedAt: record.changedAt,
    subjectSha256: createHash('sha256').update(record.subject).digest('hex'),
    bodySha256: createHash('sha256').update(body).digest('hex'),
  }
  if (key === undefined) return { preview }
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Invalid recovery signing configuration')
  const signature = createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`${now}.${body}`)
    .digest('hex')
  return {
    preview,
    request: new Request(preview.target, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'x-stillmark-time': String(now),
        'x-stillmark-signature': signature,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    }),
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (
    args[0] !== '--receipt' ||
    !args[1] ||
    args.length > 3 ||
    (args[2] !== undefined && args[2] !== '--send')
  )
    throw Error(
      'Usage: node scripts/auth0/replay-credential-change.mjs --receipt PRIVATE_FILE [--send]',
    )
  if (statSync(args[1]).size > 2048) throw Error('Recovery record is too large')
  const record = JSON.parse(readFileSync(args[1], 'utf8'))
  const send = args[2] === '--send'
  if (send && !process.env.STILLMARK_EVENT_KEY)
    throw Error('Recovery signing configuration is required')
  const { preview, request } = credentialReplay(record, {
    origin: process.env.STILLMARK_ORIGIN,
    issuer: process.env.STILLMARK_ISSUER,
    ...(send ? { key: process.env.STILLMARK_EVENT_KEY } : {}),
  })
  if (!send) {
    console.log(JSON.stringify(preview))
    return
  }
  // One explicit attempt. On an unknown outcome, replay this same record again;
  // never re-execute the Action or substitute the operator's current time.
  const response = await fetch(request)
  if (!response.ok) throw Error(`Credential replay was not acknowledged (HTTP ${response.status})`)
  console.log(JSON.stringify({ ...preview, mode: 'acknowledged', status: response.status }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Credential replay failed; inspect private inputs and operator authorization. No record or secret was printed.',
    )
    process.exitCode = 1
  })
