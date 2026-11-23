/** Add a presentation claim only; subject remains the immutable account identity. */
exports.onExecutePostLogin = async (event, api) => {
  if (event.client.client_id !== event.secrets.STILLMARK_CLIENT_ID) return
  const username = event.user.username
  if (typeof username === 'string' && username.trim()) {
    api.idToken.setCustomClaim('https://stillmark.app/username', username.trim().slice(0, 120))
  }
}
