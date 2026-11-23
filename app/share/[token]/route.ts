import { sharedLinkMetadata, sharedLinkPreview } from '@/lib/albums/shared-link-preview'
import { BRAND_ICON_LINKS } from '@/lib/branding.mjs'
import { withPublicRequest } from '@/lib/public-request'
import { withPublicDatabase } from '@/lib/database/database-context'
import { publicAlbum, shareHeaders, tokenHash } from '@/lib/albums/public-albums'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { publicPhotoDetails } from '@/lib/photos/public-photo-details'
import { listPublicPhotos, readPublicPhotoLocation } from '@/lib/photos/public-photos'
import { mapTile } from '@/lib/map-tiles.mjs'
import { runtimeMapConfig } from '@/lib/travel/map-config-server'
import { deployment } from '@/config/deployment.mjs'
import { HttpError, integer } from '@/lib/http'
import { APP_TITLE } from '@/lib/constants'
import { flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'

/** Static styles and logo inlined into the share page; read once per process. */
let assets: Promise<string[]> | undefined
function pageAssets() {
  assets ??= Promise.all(
    ['theme.css', 'viewer-menu.css', 'icon.svg', 'photo-grid.css', 'share-page.css'].map((name) =>
      readFile(join(process.cwd(), 'public', name), 'utf8'),
    ),
  ).catch((error) => {
    // Do not cache a failed read; the next request retries.
    assets = undefined
    throw error
  })
  return assets
}
const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
const menuIcon = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`
const icons = {
  full: menuIcon('M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5'),
  info: menuIcon('M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'),
  people: menuIcon(
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0m4-3.87a4 4 0 0 1 0 7.75',
  ),
  download: menuIcon('M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4'),
}
async function GETHandler(req: Request, c: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await c.params
    const link = await publicAlbum(token)
    const page = integer(new URL(req.url).searchParams.get('page') ?? 0, 'page', 0, 100000)
    if (new URL(req.url).searchParams.get('asset') === 'player')
      return new Response(await readFile(join(process.cwd(), 'public/vendor/hls.min.js'), 'utf8'), {
        headers: { ...shareHeaders, 'Content-Type': 'application/javascript' },
      })
    const url = new URL(req.url)
    const asset = url.searchParams.get('asset')
    if (asset === 'viewer-buffer')
      return new Response(
        await readFile(join(process.cwd(), 'public/viewer-image-buffer.mjs'), 'utf8'),
        {
          headers: { ...shareHeaders, 'Content-Type': 'application/javascript' },
        },
      )
    if (asset === 'og-image') return await sharedLinkPreview(token, req.signal)
    if (asset === 'preview-protocol' || asset === 'preview-client') {
      const file = asset === 'preview-protocol' ? 'preview-batch.mjs' : 'preview-batch-client.mjs'
      const source = (await readFile(join(process.cwd(), 'public', file), 'utf8')).replace(
        "'./preview-batch.mjs'",
        JSON.stringify(`/share/${token}?asset=preview-protocol`),
      )
      return new Response(source, {
        headers: { ...shareHeaders, 'Content-Type': 'application/javascript' },
      })
    }
    if (asset === 'thumbnails') {
      const batching = flagOn('PREVIEW_BATCH_ENABLED')
      const setup = batching
        ? `
import { createPreviewBatchClient } from ${JSON.stringify(`/share/${token}?asset=preview-client`)};
const base = ${JSON.stringify(`/share/${token}`)};
const batchFetch = createPreviewBatchClient(window, base + '/previews', 'ids');
mountThumbnailGrid(window, document.getElementById('grid'), {previewBatch: {
  path: (src, origin) => {
    const u = new URL(src, origin);
    if (u.origin !== origin || u.search !== '?kind=thumbnail' || !u.pathname.startsWith(base + '/media/')) return null;
    const id = u.pathname.slice((base + '/media/').length);
    return /^[1-9][0-9]*$/.test(id) ? id : null;
  }, fetch: batchFetch
}});`
        : '\nmountThumbnailGrid(window, document.getElementById("grid"));'
      return new Response(
        (await readFile(join(process.cwd(), 'public/thumbnail-loader.mjs'), 'utf8')) + setup,
        { headers: { ...shareHeaders, 'Content-Type': 'application/javascript' } },
      )
    }
    if (asset === 'info' || asset === 'controller' || asset === 'transport') {
      const file =
        asset === 'info'
          ? 'shared-album-info.js'
          : asset === 'controller'
            ? 'shared-album-controller.mjs'
            : 'shared-album-transport.mjs'
      const source = (await readFile(join(process.cwd(), 'public', file), 'utf8'))
        .replace(
          "'./viewer-image-buffer.mjs'",
          JSON.stringify(`/share/${token}?asset=viewer-buffer`),
        )
        .replace(
          "'./shared-album-transport.mjs'",
          JSON.stringify(`/share/${token}?asset=transport`),
        )
      return new Response(source, {
        headers: { ...shareHeaders, 'Content-Type': 'application/javascript' },
      })
    }
    if (url.searchParams.has('photo')) {
      const photoId = integer(url.searchParams.get('photo'), 'photo')
      if (url.searchParams.get('asset') === 'tile') {
        if (!link.include_location) throw new HttpError(403, 'Location sharing is disabled')
        const photo = await readPublicPhotoLocation(link, photoId)
        if (!photo || photo.latitude == null || photo.longitude == null)
          throw new HttpError(404, 'Location unavailable')
        const z = integer(url.searchParams.get('z'), 'zoom', 0, 19)
        const x = integer(url.searchParams.get('x'), 'tile', 0, 2 ** z - 1)
        const y = integer(url.searchParams.get('y'), 'tile', 0, 2 ** z - 1)
        const response = await mapTile(
          new Request(`${url.origin}/api/tiles/${z}/${x}/${y}`),
          deployment.GATEWAY_ORIGIN,
        )
        const headers = new Headers(response.headers)
        for (const [key, value] of Object.entries(shareHeaders)) headers.set(key, value)
        return new Response(response.body, { status: response.status, headers })
      }
      return Response.json(await publicPhotoDetails(link, photoId), { headers: shareHeaders })
    }
    const rows = await listPublicPhotos(link, page * 60)
    if (new URL(req.url).searchParams.get('format') === 'json')
      return Response.json(
        { items: rows.slice(0, 60), nextPage: rows.length > 60 ? page + 1 : null },
        { headers: shareHeaders },
      )
    const map = runtimeMapConfig()
    const photos = rows.slice(0, 60)
    const nonce = randomBytes(18).toString('base64')
    const base = `/share/${token}`
    const expiry = new Date(link.expires_at)
    const expiryLabel = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    }).format(expiry)
    const [themeCss, menuCss, brandLogo, photoGridCss, shareCss] = await pageAssets()
    // One literal per line, joined with no separator: the page text is exactly as before.
    const html = [
      `<!doctype html><html lang="en" class="dark">`,
      `<head>${BRAND_ICON_LINKS}${sharedLinkMetadata(token, link.event_name)}<meta charset="utf-8">`,
      `<meta name="viewport" content="width=device-width,initial-scale=1">`,
      `<title>${esc(link.event_name)} · Shared album · ${esc(APP_TITLE)}</title>`,
      `<style>
${themeCss}
${shareCss}
${menuCss}
 ${photoGridCss}
 </style></head>`,
      `<body data-map-url="${map.carto && link.include_location ? esc(map.url) : ''}">`,
      `<header class="album-header"><div class="album-heading"><div class="album-copy">`,
      `<p class="eyebrow">${brandLogo}${esc(APP_TITLE)} · ${link.photo_ids ? 'Shared selection' : 'Shared album'}</p>`,
      `<h1>${esc(link.event_name)}</h1><p class="album-meta">`,
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">`,
      `<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>`,
      `<span>Available until <time id="expiry" datetime="${expiry.toISOString()}">${esc(expiryLabel)}</time>`,
      `</span>`,
      `</p>${!link.allow_downloads ? '<p class="view-note">Viewing only · Original downloads are turned off.</p>' : ''}</div>${link.allow_downloads && photos.length ? `<div class="album-actions"><a class="button" href="${base}/download" aria-label="${link.photo_ids ? 'Download selected files as ZIP' : 'Download album as ZIP'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>${link.photo_ids ? 'Download selection' : 'Download album'}<span class="zip-label">ZIP</span></a><p class="download-note">Original photos &amp; videos · Full resolution</p></div>` : ''}</div>`,
      `</header>`,
      `<main id="grid" class="photo-grid photo-grid-layout">${photos.map((p, i) => `<button class="photo-tile photo-tile-button" data-index="${i}" aria-label="Open ${esc(p.source_filename)}"><img data-thumbnail-state="deferred" data-thumbnail-src="${base}/media/${p.photo_id}?kind=thumbnail" alt="${esc(p.source_filename)}">${p.media_type === 'video' ? '<span>Video</span>' : ''}</button>`).join('') || '<p>No files in this album.</p>'}</main>`,
      `<nav id="loading" role="status" aria-live="polite"></nav>`,
      `<dialog id="viewer" aria-label="Photo viewer"><div class="bar"><button id="close">Close</button>`,
      `<div class="viewer-menu">`,
      `<button id="menu-toggle" aria-expanded="false" aria-controls="viewer-actions">Menu</button>`,
      `<div id="viewer-actions" class="viewer-actions-popover viewer-action-items" hidden>`,
      `<button id="full">${icons.full}<span>Full screen</span></button>`,
      `<button id="info-toggle" aria-expanded="false" aria-controls="details">${icons.info}<span>Photo details</span>`,
      `</button>${link.include_people ? `<button id="names-toggle" aria-pressed="false">${icons.people}<span>Show names</span></button>` : ''}${link.allow_downloads ? `<a class="button" id="download">${icons.download}<span>Download original</span></a>` : ''}</div>`,
      `</div></div><div class="photo-viewer-stage"><div id="media" class="photo-viewer-media"></div>`,
      `<div class="viewer-navigation photo-viewer-navigation">`,
      `<button id="previous" aria-label="Previous photo">${menuIcon('m15 18-6-6 6-6')}</button>`,
      `<button id="next" aria-label="Next photo">${menuIcon('m9 18 6-6-6-6')}</button></div></div>`,
      `<p id="notice" role="status"></p><div id="name-labels" hidden></div>`,
      `<aside id="details" aria-label="Photo details" hidden><div class="details-heading">`,
      `<h2>Details</h2><button id="details-expand" aria-expanded="false">Expand</button>`,
      `<button id="details-close" aria-label="Close details">×</button></div>`,
      `<div id="details-body" aria-live="polite"></div></aside></dialog>`,
      `<script type="module" nonce="${nonce}" src="${base}?asset=thumbnails"></script>`,
      `<script type="module" nonce="${nonce}" src="${base}?asset=info"></script>`,
      `<script nonce="${nonce}" src="${base}?asset=player"></script>`,
      `<script type="module" nonce="${nonce}">
 import { mountSharedAlbum } from ${JSON.stringify(base + '?asset=controller')};
 mountSharedAlbum({files:${JSON.stringify(photos).replace(/</g, '\\u003c')},base:${JSON.stringify(base)},expires:${new Date(link.expires_at).getTime()},nextPage:${rows.length > 60 ? page + 1 : 'null'}});
 </script>`,
      `</body></html>`,
    ].join('')
    return new Response(html, {
      headers: {
        ...shareHeaders,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; img-src 'self' https://basemaps.cartocdn.com; media-src 'self' blob:; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      },
    })
  } catch (e) {
    return new Response(e instanceof HttpError ? e.message : 'Shared album unavailable', {
      status: e instanceof HttpError ? e.status : 500,
      headers: shareHeaders,
    })
  }
}

async function publicHandler(...args: Parameters<typeof GETHandler>) {
  const { token } = await args[1].params
  try {
    return await withPublicDatabase(tokenHash(token), () => GETHandler(...args), args[0].signal)
  } catch {
    return new Response('This link is unavailable or has expired.', {
      status: 404,
      headers: shareHeaders,
    })
  }
}

export const GET = withPublicRequest(publicHandler)
