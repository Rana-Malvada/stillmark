/** Commits the revocation through `photo_security.revoke_session`; the identity lookup reads it on every request. */
export async function revokeGatewaySession(sid: string) {
  const { pgAuthRevoke } = await import('../postgres')
  await pgAuthRevoke(sid)
}
