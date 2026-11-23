// Only public cartography is cached here. No gallery media or identity headers.
export async function mapTile(request, origin, fetcher = fetch, cache) {
  const url = new URL(request.url)
  const match = /^\/api\/tiles\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/.exec(url.pathname)
  if (!match || url.search || request.method !== 'GET')
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const [z, x, y] = match.slice(1).map(Number)
  if (z > 19 || x >= 2 ** z || y >= 2 ** z)
    return new Response('Invalid tile', { status: 400, headers: { 'Cache-Control': 'no-store' } })
  const key = new Request(`${origin}/api/tiles/${z}/${x}/${y}`)
  const cached = await cache?.match(key)
  if (cached) return conditional(request, cached)
  const headers = new Headers({
    'User-Agent': `PersonalPhotos/1.0 (+${origin})`,
    Referer: `${origin}/`,
  })
  for (const name of ['If-None-Match', 'If-Modified-Since'])
    if (request.headers.has(name)) headers.set(name, request.headers.get(name))
  const upstream = await fetcher(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  })
  if (upstream.status !== 200 && upstream.status !== 304)
    return new Response('Map tile unavailable', {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    })
  const outgoing = new Headers({ 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff' })
  for (const name of ['Cache-Control', 'Expires', 'ETag', 'Last-Modified', 'Date', 'Age'])
    if (upstream.headers.has(name)) outgoing.set(name, upstream.headers.get(name))
  if (!outgoing.has('Cache-Control') && !outgoing.has('Expires'))
    outgoing.set('Cache-Control', 'public, max-age=604800')
  const response = new Response(upstream.status === 304 ? null : upstream.body, {
    status: upstream.status,
    headers: outgoing,
  })
  if (
    cache &&
    response.status === 200 &&
    !/\b(private|no-store|no-cache)\b/i.test(outgoing.get('Cache-Control') ?? '')
  ) {
    // Cache failure must not break the map. Provider no-store/private is preserved.
    try {
      await cache.put(key, response.clone())
    } catch {
      // The tile is still served; it only misses the cache this time.
    }
  }
  return conditional(request, response)
}
function conditional(request, response) {
  const tag = response.headers.get('ETag')
  if (tag && request.headers.get('If-None-Match') === tag)
    return new Response(null, { status: 304, headers: response.headers })
  return response
}
