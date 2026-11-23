/** Read-only preflight: a successful fallback is not direct-media readiness. */
export async function checkGatewayMedia({ origin, cookie, username }, fetcher = fetch) {
  if (
    !/^https:\/\/stillmark-loadtest-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(origin) ||
    !/^STILLMARK_LOADTEST_[A-Z0-9]+_U[1-9][0-9]*$/.test(username) ||
    typeof cookie !== 'string' ||
    !cookie.startsWith('__Host-photo-session=')
  )
    throw Error('Isolated gateway identity required')
  const get = (path) =>
    fetcher(origin + path, {
      headers: { Cookie: cookie, 'User-Agent': 'Stillmark-Isolated-Preflight/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
  const identity = await get('/api/auth/me')
  if (!identity.ok || (await identity.json()).username !== username)
    throw Error('Gateway identity failed')
  const listing = await get('/api/events?paged=true&scope=mine')
  if (!listing.ok) throw Error('Gateway listing failed')
  const albums = (await listing.json()).items
  if (!Array.isArray(albums) || albums.some((a) => a.ownerUsername !== username))
    throw Error('Gateway owner scope failed')
  const cover = albums.find((a) => typeof a.coverUrl === 'string')?.coverUrl
  if (!cover?.startsWith('/api/images?')) throw Error('Synthetic cover missing')
  const image = await get(cover)
  try {
    if (
      image.status !== 200 ||
      image.headers.get('x-media-delivery') !== 'storage' ||
      !image.headers.get('content-type')?.startsWith('image/')
    )
      throw Error(
        'Direct storage delivery failed; do not benchmark the fallback as direct delivery',
      )
    return { directMedia: true, placement: image.headers.get('cf-placement') }
  } finally {
    await image.body?.cancel()
  }
}
