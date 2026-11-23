// Install as an Auth0 post-change-password Action. Secrets are configured in Auth0,
// never committed: STILLMARK_ORIGIN, STILLMARK_EVENT_KEY, STILLMARK_ISSUER.
const { createHmac } = require('node:crypto')

exports.onExecutePostChangePassword = async (event) => {
  const origin = new URL(event.secrets.STILLMARK_ORIGIN)
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw Error('Invalid Stillmark origin')
  const changedAt = Math.floor(Date.now() / 1000)
  const body = JSON.stringify({
    issuer: event.secrets.STILLMARK_ISSUER,
    subject: event.user.user_id,
    changedAt,
  })
  for (let attempt = 0; attempt < 3; attempt++) {
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = createHmac('sha256', Buffer.from(event.secrets.STILLMARK_EVENT_KEY, 'hex'))
      .update(`${timestamp}.${body}`)
      .digest('hex')
    try {
      const response = await fetch(new URL('/auth/credential-change', origin), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-stillmark-time': String(timestamp),
          'x-stillmark-signature': signature,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      })
      if (response.status === 200 || response.status === 202) {
        const acknowledgment = await response.json()
        if (
          acknowledgment.accepted === true &&
          (response.status === 200
            ? acknowledgment.persisted === true
            : acknowledgment.durable === true)
        )
          return
      }
    } catch {}
  }
  // This Action is asynchronous and cannot roll back the password change.
  // The checkpoint poller independently retains successful-password-change (scp) events.
  // Preserve the original cutoff for an authorized replay. Never log the event,
  // secrets, signatures, request headers, or an upstream response body.
  console.error(
    JSON.stringify({
      event: 'stillmark_credential_delivery_failed',
      version: 1,
      issuer: event.secrets.STILLMARK_ISSUER,
      subject: event.user.user_id,
      changedAt,
      attempts: 3,
    }),
  )
  throw Error('Stillmark session revocation was not acknowledged')
}
