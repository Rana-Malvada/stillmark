/**
 * Private operational correlation without logging a user ID, issuer or credential.
 * @param {CredentialEvent} event
 * @param {Env} env
 * @param {string} source
 * @param {string} result
 */
export async function credentialReceipt(event, env, source, result) {
  try {
    if (
      !/^[a-f0-9]{64}$/.test(env.AUTH0_LOG_STREAM_TOKEN ?? '') ||
      !['action', 'log-stream', 'log-poll'].includes(source) ||
      !['persisted', 'durable'].includes(result)
    )
      return
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(
        // Checked above to be 64 hex characters, so it is set and always matches.
        /** @type {string[]} */ (/** @type {string} */ (env.AUTH0_LOG_STREAM_TOKEN).match(/../g)),
        (byte) => parseInt(byte, 16),
      ),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(
        'stillmark-credential-receipt-v1\n' + event.issuer + '\n' + event.subject,
      ),
    )
    console.info(
      JSON.stringify({
        event: 'stillmark_credential_receipt',
        version: 1,
        source,
        result,
        changedAt: event.changedAt,
        subjectFingerprint: Array.from(new Uint8Array(signature), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      }),
    )
  } catch {
    // Telemetry must not turn an acknowledged revocation into a failed delivery.
  }
}
