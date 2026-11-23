import { EncryptJWT } from 'jose'
import { randomUUID } from 'node:crypto'

/** Offline fixture creation, never imported by a deployed Worker. */
export async function testSessions(
  namespace,
  usernames,
  keyHex,
  now = Math.floor(Date.now() / 1000),
) {
  if (!/^STILLMARK_LOADTEST_[A-Z0-9]+$/.test(namespace) || !/^[a-f0-9]{64}$/.test(keyHex))
    throw Error('Isolated namespace and independent session key required')
  if (!usernames.length || usernames.length > 5000 || new Set(usernames).size !== usernames.length)
    throw Error('Distinct test identities required')
  const key = Uint8Array.from(Buffer.from(keyHex, 'hex'))
  return Promise.all(
    usernames.map(async (username) => {
      if (!new RegExp('^' + namespace + '_U[1-9][0-9]*$').test(username))
        throw Error('Non-test identity rejected')
      const subject = 'auth0|' + username.toLowerCase()
      const sid = randomUUID()
      const token = await new EncryptJWT({
        auth0Subject: subject,
        sid,
        startedAt: now,
        absoluteExpiresAt: now + 3600,
        revocationBackend: 'postgres',
      })
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .setSubject('gallery-session')
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .encrypt(key)
      return { username, subject, sid, cookie: '__Host-photo-session=' + token }
    }),
  )
}
