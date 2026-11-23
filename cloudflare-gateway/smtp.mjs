import { deployment } from '../config/deployment.mjs'

const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

/**
 * @typedef {import('cloudflare:sockets').Socket} Socket
 * @typedef {typeof import('cloudflare:sockets').connect} Connect
 */

/**
 * Mailbox login, sender and recipient, read from Worker secrets so no personal
 * address is committed. Each must be a single plain address: anything else,
 * including a value carrying a line break, is refused before it reaches an SMTP
 * command or a message header.
 * @param {Env} env
 * @returns {{ username: string, from: string, to: string }}
 */
export function alertAddresses(env) {
  const mail = { username: env.ALERT_SMTP_USERNAME, from: env.ALERT_FROM, to: env.ALERT_TO }
  for (const value of Object.values(mail))
    if (typeof value !== 'string' || !ADDRESS.test(value)) throw Error('Invalid configuration')
  return /** @type {{ username: string, from: string, to: string }} */ (mail)
}

// iCloud SMTP: credentials are transmitted only after a verified STARTTLS upgrade.
/**
 * @param {Env} env
 * @param {Connect} connect
 * @param {string} subject
 * @param {string} body
 * @returns {Promise<AlertDelivery>}
 */
export async function sendAlertEmail(env, connect, subject, body) {
  let /** @type {Socket | undefined} */ socket
  /** @type {ReadableStreamDefaultReader<Uint8Array> | undefined} */ let reader
  /** @type {WritableStreamDefaultWriter<Uint8Array> | undefined} */ let writer
  let buffer = ''
  let stage = 'connect'
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  /** @param {Socket} s */
  const attach = (s) => {
    socket = s
    reader = s.readable.getReader()
    writer = s.writable.getWriter()
    buffer = ''
    s.closed.catch(() => {})
  }
  const line = async () => {
    while (!buffer.includes('\r\n')) {
      const r = await /** @type {NonNullable<typeof reader>} */ (reader).read()
      if (r.done) throw Error('SMTP closed')
      buffer += decoder.decode(r.value)
      if (buffer.length > 16384) throw Error('SMTP response too large')
    }
    const i = buffer.indexOf('\r\n')
    const text = buffer.slice(0, i)
    buffer = buffer.slice(i + 2)
    return text
  }
  /** @param {number} expected */
  const reply = async (expected) => {
    for (let i = 0; i < 100; i++) {
      const text = await line()
      if (!/^\d{3}[ -]/.test(text)) throw Error('Invalid SMTP response')
      if (text[3] === ' ') {
        const code = Number(text.slice(0, 3))
        if (code !== expected) throw Error(`SMTP ${code}`)
        return
      }
    }
    throw Error('SMTP response too long')
  }
  /**
   * @param {string} text
   * @param {number} expected
   */
  const command = async (text, expected) => {
    await /** @type {NonNullable<typeof writer>} */ (writer).write(encoder.encode(text + '\r\n'))
    await reply(expected)
  }
  const timeout = setTimeout(() => {
    socket?.close().catch(() => {})
  }, 25000)
  try {
    if (
      !env.ICLOUD_SMTP_PASSWORD ||
      /[\r\n]/.test(subject) ||
      subject.length > 150 ||
      body.length > 10000
    )
      throw Error('Invalid configuration')
    const mail = alertAddresses(env)
    attach(connect({ hostname: deployment.SMTP_HOST, port: 587 }, { secureTransport: 'starttls' }))
    await reply(220)
    stage = 'starttls'
    await command('EHLO ' + new URL(deployment.GATEWAY_ORIGIN).hostname, 250)
    await command('STARTTLS', 220)
    // attach() assigned the socket and its reader and writer; the checker cannot see that.
    ;/** @type {NonNullable<typeof reader>} */ (reader).releaseLock()
    ;/** @type {NonNullable<typeof writer>} */ (writer).releaseLock()
    attach(/** @type {Socket} */ (socket).startTls())
    await /** @type {Socket} */ (socket).opened
    await command('EHLO ' + new URL(deployment.GATEWAY_ORIGIN).hostname, 250)
    stage = 'authenticate'
    await command(
      'AUTH PLAIN ' + btoa('\0' + mail.username + '\0' + env.ICLOUD_SMTP_PASSWORD.trim()),
      235,
    )
    stage = 'sender'
    await command(`MAIL FROM:<${mail.from}>`, 250)
    stage = 'recipient'
    await command(`RCPT TO:<${mail.to}>`, 250)
    stage = 'message'
    await command('DATA', 354)
    const message = [
      `From: Stillmark Alerts <${mail.from}>`,
      'To: ' + mail.to,
      'Subject: Stillmark - ' + subject,
      'Date: ' + new Date().toUTCString(),
      'Message-ID: <' +
        crypto.randomUUID() +
        '@' +
        new URL(deployment.GATEWAY_ORIGIN).hostname +
        '>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..'),
      '',
      '.',
    ].join('\r\n')
    await command(message, 250)
    return { accepted: true }
  } catch (/** @type {any} */ error) {
    return {
      accepted: false,
      stage,
      error: /^SMTP \d{3}$/.test(error.message)
        ? error.message
        : 'Connection or configuration failure',
    }
  } finally {
    clearTimeout(timeout)
    try {
      await socket?.close()
    } catch {}
  }
}
