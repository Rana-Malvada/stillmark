import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ album: vi.fn(), query: vi.fn() }))
vi.mock('@/lib/database/database-context', () => ({
  withPublicDatabase: async (_: unknown, fn: () => unknown) => fn(),
}))
vi.mock('@/lib/albums/public-albums', () => ({
  tokenHash: () => 'hash',
  publicAlbum: mocks.album,
  shareHeaders: { 'Cache-Control': 'private, no-store' },
}))
vi.mock('@/lib/postgres', () => ({ pgQuery: mocks.query }))
vi.mock('@/lib/travel/map-config-server', () => ({
  runtimeMapConfig: () => ({
    carto: true,
    url: 'https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=test-key',
  }),
}))
import { GET } from '@/app/share/[token]/route'
import { createContext, Script } from 'node:vm'
import { isSharedPage, sharedJson, sharedRequest } from '../public/shared-album-transport.mjs'

beforeEach(() => {
  mocks.album.mockReset().mockResolvedValue({
    event_id: 1,
    event_name: 'Album',
    expires_at: '2099-01-01',
    allow_downloads: true,
  })
  mocks.query.mockReset().mockResolvedValue(
    Array.from({ length: 61 }, (_, i) => ({
      photo_id: i + 1,
      source_filename: `photo ${i}.jpg`,
      media_type: 'photo',
    })),
  )
})
const request = (query = '') =>
  GET(new Request('https://example.com/share/token' + query), {
    params: Promise.resolve({ token: 'token' }),
  })
it('renders compact thumbnails and valid automatic-loading viewer script without page buttons', async () => {
  const response = await request()
  const html = await response.text()
  expect(html).toContain('photo-grid photo-grid-layout')
  expect(html).not.toContain('Next page')
  expect(await (await request('?asset=controller')).text()).toContain('IntersectionObserver')
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter(Boolean)
  expect(scripts).toHaveLength(1)
  expect(() => new Script(scripts[0].replace(/^\s*import .*?;$/m, ''))).not.toThrow()
  expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'nonce-")
})
it('returns bounded batches after checking the share permission', async () => {
  const response = await request('?format=json&page=1')
  const data = await response.json()
  expect(mocks.album).toHaveBeenCalledWith('token')
  expect(mocks.query.mock.calls[0][1]).toEqual([1, 60, null])
  expect(data.items).toHaveLength(60)
  expect(data.nextPage).toBe(2)
  expect(response.headers.get('Cache-Control')).toContain('no-store')
  mocks.query.mockResolvedValue([])
  expect((await (await request('?format=json&page=2')).json()).nextPage).toBeNull()
})
it('only supplies the direct tile template when the owner shares location', async () => {
  expect(await (await request()).text()).not.toContain('?key=test-key')
  mocks.album.mockResolvedValue({
    event_id: 1,
    event_name: 'Album',
    expires_at: '2099-01-01',
    include_location: true,
  })
  const response = await request()
  const html = await response.text()
  expect(html).toContain(
    'data-map-url="https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=test-key"',
  )
  expect(response.headers.get('Content-Security-Policy')).toContain(
    "img-src 'self' https://basemaps.cartocdn.com;",
  )
})
it('rejects revoked or expired shares before loading another batch', async () => {
  mocks.album.mockRejectedValue(new Error('revoked'))
  expect((await request('?format=json&page=1')).status).toBe(500)
  expect(mocks.query).not.toHaveBeenCalled()
})
it('offers an album ZIP only when downloads are allowed and the album has files', async () => {
  expect(await (await request()).text()).toContain(
    'href="/share/token/download" aria-label="Download album as ZIP"',
  )
  mocks.album.mockResolvedValue({
    event_id: 1,
    event_name: 'Album',
    expires_at: '2099-01-01',
    allow_downloads: false,
  })
  expect(await (await request()).text()).not.toContain('Download album as ZIP')
  mocks.album.mockResolvedValue({
    event_id: 1,
    event_name: 'Album',
    expires_at: '2099-01-01',
    allow_downloads: true,
  })
  mocks.query.mockResolvedValue([])
  expect(await (await request()).text()).not.toContain('Download album as ZIP')
})

it('defers both initial and appended shared thumbnails to the common loader', async () => {
  const html = await (await request()).text()
  expect(html).toContain('type="module"')
  expect(html).toContain('?asset=thumbnails')
  expect(html).toContain('data-thumbnail-src="/share/token/media/1?kind=thumbnail"')
  expect(html).not.toMatch(/<img[^>]*\ssrc=/)
  expect(await (await request('?asset=controller')).text()).toContain('img.dataset.thumbnailSrc =')
  const asset = await request('?asset=thumbnails')
  const script = await asset.text()
  expect(asset.headers.get('Content-Type')).toBe('application/javascript')
  expect(script).toContain('export function createThumbnailLoader')
  expect(script).toContain('mountThumbnailGrid(window, document.getElementById("grid"))')
})

// Execute the rendered viewer, using the real common buffer and a minimal DOM.
import { preloadWindow, ViewerImageBuffer } from '@/lib/viewer-image-buffer'

async function viewerHarness(fetchPage: (...args: any[]) => unknown = vi.fn()) {
  const html = await (await request()).text()
  const bootstrap = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((s) => s.includes('mountSharedAlbum'))!
  const controllerCode = await (await request('?asset=controller')).text()
  const code =
    controllerCode
      .replace(/^import .*? from .*?$/gm, '')
      .replace('export function mountSharedAlbum', 'function mountSharedAlbum') +
    '\n' +
    bootstrap
      .replace(/^\s*import .*?;$/m, '')
      .replace('mountSharedAlbum(', 'globalThis.testViewer = mountSharedAlbum(')
  class Element {
    open = false
    isConnected = false
    complete = false
    naturalWidth = 0
    naturalHeight = 0
    src = ''
    dataset = {}
    children: any[] = []
    onclose?: () => void
    onload?: () => void
    addEventListener() {}
    setAttribute() {}
    removeAttribute(name: string) {
      if (name === 'src') this.src = ''
    }
    remove() {
      this.isConnected = false
    }
    append(el: any) {
      this.children.push(el)
      el.isConnected = true
    }
    replaceChildren(...els: any[]) {
      this.children.forEach((e) => (e.isConnected = false))
      this.children = []
      els.forEach((e) => this.append(e))
    }
    showModal() {
      this.open = true
    }
    close() {
      this.open = false
      this.onclose?.()
    }
    getBoundingClientRect() {
      return { top: 100000 }
    }
  }
  const nodes = new Map<string, Element>()
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element())
    return nodes.get(id)!
  }
  const images: Element[] = []
  const context = createContext({
    ViewerImageBuffer: class extends ViewerImageBuffer {
      constructor() {
        super(() => {
          const image = new Element()
          images.push(image)
          return image as unknown as HTMLImageElement
        })
      }
    },
    preloadWindow,
    sharedJson,
    sharedRequest,
    isSharedPage,
    AbortController,
    AbortSignal,
    document: {
      getElementById: node,
      querySelector: node,
      createElement: () => new Element(),
      addEventListener() {},
      dispatchEvent() {},
      body: new Element(),
    },
    window: { addEventListener() {} },
    innerHeight: 800,
    Intl,
    Date,
    fetch: fetchPage,
    setInterval() {},
    setTimeout,
    clearTimeout,
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
    CustomEvent: class {},
    Event: class {},
  })
  new Script(code).runInContext(context)
  return { api: context.testViewer, images, node }
}
it('uses the common buffer for current, next two and previous, reusing the preloaded element', async () => {
  const { api, images, node } = await viewerHarness()
  await api.show(2)
  expect(images.map((i) => i.src)).toEqual(['/share/token/media/3?kind=display'])
  await api.warmNeighbors(2, api.getVersion())
  expect(images.map((i) => i.src)).toEqual(
    [3, 4, 5, 2].map((id) => `/share/token/media/${id}?kind=display`),
  )
  const next = images[1]
  await api.show(3)
  expect(node('media').children[0]).toBe(next)
  expect(images).toHaveLength(4)
  node('viewer').close()
  expect(images.every((i) => i.src === '')).toBe(true)
})
it('preloads across pagination and ignores stale warming after close', async () => {
  let resolve!: (response: unknown) => void
  const fetchPage = vi.fn(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const { api, images, node } = await viewerHarness(fetchPage)
  await api.show(59)
  const warm = api.warmNeighbors(59, api.getVersion())
  expect(fetchPage).toHaveBeenCalledWith(
    '/share/token?format=json&page=1',
    expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
  )
  resolve({
    ok: true,
    json: async () => ({
      items: [61, 62].map((photo_id) => ({
        photo_id,
        media_type: 'photo',
        source_filename: 'photo.jpg',
      })),
      nextPage: null,
    }),
  })
  await warm
  expect(images.map((i) => i.src)).toEqual(
    [60, 61, 62, 59].map((id) => `/share/token/media/${id}?kind=display`),
  )
  node('viewer').close()
  await api.warmNeighbors(59, api.getVersion() - 1)
  expect(images.every((i) => i.src === '')).toBe(true)
})
it('serves the same buffer implementation through the authorized share asset', async () => {
  const response = await request('?asset=viewer-buffer')
  expect(await response.text()).toContain('export class ViewerImageBuffer')
  expect(mocks.query).not.toHaveBeenCalled()
  mocks.album.mockRejectedValue(new Error('revoked'))
  expect((await request('?asset=viewer-buffer')).status).not.toBe(200)
})

it('does not start image downloads after closing during a pagination request', async () => {
  let resolve!: (response: unknown) => void
  const { api, images, node } = await viewerHarness(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  await api.show(59)
  const warm = api.warmNeighbors(59, api.getVersion())
  node('viewer').close()
  resolve({
    ok: true,
    json: async () => ({
      items: [61, 62].map((photo_id) => ({
        photo_id,
        media_type: 'photo',
        source_filename: 'photo.jpg',
      })),
      nextPage: null,
    }),
  })
  await warm
  expect(images).toHaveLength(1)
  expect(images[0].src).toBe('')
})
it('does not preload neighboring video media', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    photo_id: i + 1,
    source_filename: 'media',
    media_type: i === 3 ? 'video' : 'photo',
  }))
  mocks.query.mockResolvedValue(rows)
  const { api, images } = await viewerHarness()
  await api.show(2)
  await api.warmNeighbors(2, api.getVersion())
  expect(images.map((i) => i.src)).toEqual(
    [3, 5, 2].map((id) => `/share/token/media/${id}?kind=display`),
  )
})

it('renders the same tight photo tiles in shared links and regular grids, including later pages', async () => {
  const { chromium } = await import('playwright-core')
  const { readFile } = await import('node:fs/promises')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { VirtualPhotoGrid } = await import('@/components/virtual-photo-grid')
  const { PhotoCard } = await import('@/components/photo-card')
  const css = await readFile('public/photo-grid.css', 'utf8')
  const rows = Array.from({ length: 63 }, (_, i) => ({
    photo_id: i + 1,
    source_filename: `photo ${i}.jpg`,
    media_type: 'photo',
  }))
  mocks.query.mockImplementation((_: unknown, params: number[]) =>
    Promise.resolve(rows.slice(params[1], params[1] + 61)),
  )
  const sharedHtml = await (await request()).text()
  const regularHtml = renderToStaticMarkup(
    createElement(VirtualPhotoGrid, {
      items: rows,
      enabled: false,
      render: (item: unknown) => {
        const row = item as (typeof rows)[number]
        return createElement(PhotoCard, {
          key: row.photo_id,
          filename: row.source_filename,
          thumbnailUrl: '/thumbnail',
        })
      },
    }),
  )
  const browser = await chromium.launch({
    ...(process.env.CLIENT_TEST_BROWSER_PATH
      ? { executablePath: process.env.CLIENT_TEST_BROWSER_PATH }
      : { channel: 'chrome' }),
    headless: true,
  })
  try {
    const page = await browser.newPage()
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/share/token') {
        if (!url.search) return route.fulfill({ contentType: 'text/html', body: sharedHtml })
        const response = await request(url.search)
        return route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        })
      }
      return route.fulfill({ status: 204 })
    })
    for (const [width, columns] of [
      [390, 3],
      [900, 4],
      [1440, 6],
      [2000, 8],
    ]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('https://example.com/share/token')
      const geometry = async (selector: string) =>
        page.locator(selector).evaluate((el) => {
          const tiles = [...el.querySelectorAll('.photo-tile-button')]
          const a = tiles[0].getBoundingClientRect()
          const b = tiles[1].getBoundingClientRect()
          const style = getComputedStyle(tiles[0])
          return {
            gap: b.left - a.right,
            square: Math.abs(a.width - a.height) < 0.1,
            radius: style.borderRadius,
            border: style.borderTopWidth,
            columns: Number(getComputedStyle(el).getPropertyValue('--photo-columns')),
          }
        })
      const expected = { gap: 1, square: true, radius: '0px', border: '0px', columns }
      expect(await geometry('#grid')).toEqual(expected)
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForFunction(
        () => document.querySelectorAll('#grid .photo-tile-button').length === 63,
      )
      expect(
        await page
          .locator('#grid .photo-tile-button')
          .last()
          .evaluate((el) => ({
            radius: getComputedStyle(el).borderRadius,
            border: getComputedStyle(el).borderTopWidth,
          })),
      ).toEqual({ radius: '0px', border: '0px' })
      await page.setContent(`<style>${css}</style>${regularHtml}`)
      expect(await geometry('.photo-grid')).toEqual(expected)
    }
  } finally {
    await browser.close()
  }
}, 30000)

it('retries malformed public pagination without losing the cursor or duplicating rows', async () => {
  const fetchPage = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [{ photo_id: 'bad' }], nextPage: null }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [60, 61, 61].map((photo_id) => ({
          photo_id,
          media_type: 'photo',
          source_filename: 'photo.jpg',
        })),
        nextPage: null,
      }),
    })
  const { api, node } = await viewerHarness(fetchPage)
  await api.loadMore()
  expect(node('grid').children).toHaveLength(0)
  await api.loadMore()
  expect(fetchPage.mock.calls.map((call) => call[0])).toEqual([
    '/share/token?format=json&page=1',
    '/share/token?format=json&page=1',
  ])
  expect(node('grid').children).toHaveLength(1)
})

it('cancels a stale playlist handshake on close and lets a reopened viewer progress', async () => {
  mocks.query.mockResolvedValue([
    { photo_id: 1, source_filename: 'video.mp4', media_type: 'video' },
  ])
  let finish!: (value: unknown) => void
  let signal!: AbortSignal
  const fetchPage = vi.fn((_url, init) => {
    signal = init.signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const { api, node } = await viewerHarness(fetchPage)
  const opening = api.show(0)
  await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledOnce())
  const stale = node('media').children[0]
  node('viewer').close()
  expect(signal.aborted).toBe(true)
  await opening
  fetchPage.mockImplementation(async () => ({ ok: true, status: 204, body: null }))
  await api.show(0)
  const current = node('media').children[0]
  expect(current.src).toBe('/share/token/media/1?kind=display')
  finish({ ok: true, status: 204, body: null })
  await Promise.resolve()
  expect(stale.src).toBe('')
  expect(node('media').children[0]).toBe(current)
})

it('bounds public pagination header and body stalls and allows direct retry', async () => {
  vi.useFakeTimers()
  try {
    const fetchPage = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [], nextPage: null }) })
    const { api, node } = await viewerHarness(fetchPage)
    for (let n = 0; n < 2; n++) {
      const pending = api.loadMore()
      await vi.advanceTimersByTimeAsync(30_001)
      await pending
      expect(node('loading').children.at(-1).textContent).toBe('Retry')
    }
    await api.loadMore()
    expect(fetchPage).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})

it('recovers public page, details and stale playlist faults in Chrome without changing tiles', async () => {
  const { chromium } = await import('playwright-core')
  mocks.query.mockResolvedValue(
    Array.from({ length: 61 }, (_, i) => ({
      photo_id: i + 1,
      source_filename: `media ${i}`,
      media_type: i === 0 ? 'video' : 'photo',
    })),
  )
  const html = await (await request()).text()
  const browser = await chromium.launch({
    ...(process.env.CLIENT_TEST_BROWSER_PATH
      ? { executablePath: process.env.CLIENT_TEST_BROWSER_PATH }
      : { channel: 'chrome' }),
    headless: true,
  })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      const later = window.setTimeout
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
        later(fn, ms === 30000 ? 150 : ms, ...args)) as typeof window.setTimeout
      const original = window.fetch
      let stalled = true
      window.fetch = (input, init) => {
        if (String(input).includes('?photo=') && stalled) {
          stalled = false
          return Promise.resolve(
            new Response(new ReadableStream({ start() {} }), {
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }
        return original(input, init)
      }
    })
    let pages = 0
    let playlists = 0
    let oldPlaylist: import('playwright-core').Route | undefined
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/share/token') {
        if (!url.search) return route.fulfill({ contentType: 'text/html', body: html })
        if (url.searchParams.get('format') === 'json') {
          pages++
          if (pages === 1) return // Header stall: the actual request deadline releases Retry.
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(
              pages === 2
                ? { items: null, nextPage: null }
                : {
                    items: [60, 61, 61].map((photo_id) => ({
                      photo_id,
                      source_filename: 'Later photo',
                      media_type: 'photo',
                    })),
                    nextPage: null,
                  },
            ),
          })
        }
        if (url.searchParams.has('photo'))
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ details: { source_filename: 'Shared video' }, people: [] }),
          })
        const response = await request(url.search)
        return route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        })
      }
      if (url.searchParams.get('kind') === 'playlist') {
        playlists++
        if (playlists === 1) {
          oldPlaylist = route
          return
        }
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({ status: 204 })
    })
    await page.goto('https://example.com/share/token')
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await vi.waitFor(() => expect(pages).toBe(2))
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('#grid button[data-index]').length === 61,
    )
    await page.locator('#grid button').first().click()
    await vi.waitFor(() => expect(playlists).toBe(1))
    await page.locator('#close').click()
    await page.locator('#grid button').first().click()
    await vi.waitFor(() => expect(playlists).toBe(2))
    await oldPlaylist?.fulfill({ status: 204 }).catch(() => {})
    expect(await page.locator('#media video').count()).toBe(1)
    await page.waitForFunction(
      () =>
        document.querySelector('#media video')?.getAttribute('src') ===
        '/share/token/media/1?kind=display',
    )
    await page.locator('#menu-toggle').click()
    await page.locator('#info-toggle').click()
    await page
      .getByText(
        'Details unavailable. The link may have expired. Close and reopen Info to retry.',
        { exact: true },
      )
      .waitFor()
    await page.locator('#details-close').click()
    await page.locator('#menu-toggle').click()
    await page.locator('#info-toggle').click()
    await page.getByText('Shared video', { exact: true }).waitFor()
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
}, 20_000)
