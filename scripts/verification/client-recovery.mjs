/** Real-browser regressions against the actual React components, synthetic APIs only. */
import { PREVIEW_CONTENT_TYPE, previewBatchStream } from '../../public/preview-batch.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import { photoGridCapabilityChecks } from './photo-grid-capabilities.mjs'
import { peoplePickerChecks } from './people-picker-checks.mjs'
import { peopleControllerChecks } from './people-controller-checks.mjs'
import { maintainabilityChecks } from './maintainability-checks.mjs'
import { processingProgressChecks } from './processing-progress.mjs'
import { galleryNavigationChecks } from './gallery-navigation.mjs'
import { identityActivityChecks } from './identity-activity-checks.mjs'
import { accessPanelChecks } from './access-panel-checks.mjs'
import { galleryMaintainabilityChecks } from './gallery-maintainability-checks.mjs'
import { photoViewerChecks } from './photo-viewer-checks.mjs'
import { reportMapChecks } from './report-map-checks.mjs'
import { uploadPickerChecks } from './upload-picker-checks.mjs'
import { sharingPanelChecks } from './sharing-panel-checks.mjs'
import { galleryStatusChecks } from './gallery-status-checks.mjs'
import { selectionLayoutChecks } from './selection-layout.mjs'
import { clientBoundaryRecoveryChecks } from './client-boundary-recovery-checks.mjs'
import { albumDestinationChecks } from './album-destination-checks.mjs'

const fixture = fileURLToPath(new URL('./client-recovery/', import.meta.url))
const bundle = await build({
  entryPoints: [fixture + 'app.jsx'],
  bundle: true,
  write: false,
  loader: { '.css': 'empty' },
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'fixture-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /^actual-auth$/ }, () => ({
          path: fileURLToPath(new URL('../../components/auth-provider.tsx', import.meta.url)),
        }))
        builder.onResolve({ filter: /auth-provider$/ }, (args) =>
          args.importer.endsWith('/app/account/page.tsx')
            ? {
                path: fileURLToPath(new URL('../../components/auth-provider.tsx', import.meta.url)),
              }
            : undefined,
        )
        builder.onResolve({ filter: /^next\/image$/ }, () => ({ path: fixture + 'image.jsx' }))
        builder.onResolve(
          {
            filter:
              /^(next\/(link|navigation)|.*\/(auth-provider|upload-provider|theme-provider))$/,
          },
          () => ({
            path: fixture + 'stubs.jsx',
          }),
        )
      },
    },
  ],
})
const photoGridCss = await readFile(new URL('../../public/photo-grid.css', import.meta.url), 'utf8')
const stylesheet = new URL('../../app/globals.css', import.meta.url)
const layoutCss = (
  await postcss([tailwind()]).process(await readFile(stylesheet, 'utf8'), {
    from: fileURLToPath(stylesheet),
  })
).css
const leafletCss = await readFile(
  new URL('../../node_modules/leaflet/dist/leaflet.css', import.meta.url),
  'utf8',
)
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 20px; font: 16px sans-serif } button,input,select { margin: 4px; padding: 5px }
svg { width: 20px; height: 20px } .relative { position: relative } .absolute { position: absolute }
.left-0 { left: 0 } .right-0 { right: 0 } .grid { display: grid } .hidden { display: none }
${photoGridCss}
</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`
// Costs use an HTTP fixture (not browser interception) so navigation really closes
// the initiating request. Actual refresh persistence is tested in cost-report.test.ts.
let costRefresh
const costData = (updated = false) => ({
  selected: 'all',
  selectedLabel: 'All users',
  canFilter: false,
  canRefresh: true,
  users: [],
  userLabels: {},
  errors: [],
  staleSources: [],
  services: [],
  daily: [],
  subtotalUsd: updated ? 21 : 20,
  asOf: updated ? '2026-11-10T20:00:00Z' : '2026-11-10T19:00:00Z',
  prices: { creditUsd: 2 },
  storage: { bytes: 0, files: 0, monthlyUsd: 0 },
  transfers: { uploadedBytes: 0, requestedDownloadBytes: 0 },
  timeZone: 'America/New_York',
  periodEnd: '2026-11-10',
  trackingStarted: null,
})
const server = createServer((req, res) => {
  if (req.url === '/layout.css') {
    res.setHeader('Content-Type', 'text/css')
    res.end(layoutCss + '\n' + leafletCss)
  } else if (req.url === '/fixture.js') {
    res.setHeader('Content-Type', 'application/javascript')
    res.end(bundle.outputFiles[0].contents)
  } else if (req.url === '/api/my-costs' && costRefresh) {
    costRefresh.reads++
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(costData(costRefresh.done)))
  } else if (req.url === '/api/costs' && req.method === 'POST' && costRefresh) {
    const state = costRefresh
    state.posts++
    res.on('close', () => {
      state.disconnected = !state.done
    })
    state.finish = () => {
      state.done = true
      if (!res.destroyed) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ asOf: costData(true).asOf }))
      }
    }
  } else if (req.url === '/api/costs?progress=1' && costRefresh) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ asOf: costData(costRefresh.done).asOf, sources: [] }))
  } else if (req.url?.startsWith('/api/')) {
    res.writeHead(500).end('Unmocked fixture API')
  } else {
    res.setHeader('Content-Type', 'text/html')
    res.end(html)
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
const personId = '11111111-1111-4111-8111-111111111111'
const person = (id = personId, name = 'Alice') => ({
  person: { personId: id, name, hidden: false, coverFaceId: null, photoCount: 0, reviewCount: 0 },
  faces: [],
  more: false,
  nextCursor: null,
})
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const modes = ['network', 'html', 'malformed', 'conflict']
async function fail(route, mode) {
  if (mode === 'network') return route.abort('connectionfailed')
  if (mode === 'html')
    return route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' })
  if (mode === 'malformed')
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{broken' })
  return json(route, { error: 'Name already exists' }, 409)
}
async function scenario(name, work) {
  if (process.env.CLIENT_SCENARIO_FILTER && !name.includes(process.env.CLIENT_SCENARIO_FILTER))
    return
  const context = await browser.newContext({ viewport: { width: 1200, height: 700 } })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  // Block every non-local request, including accidentally introduced telemetry/media.
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  )
  try {
    await work(page)
    assert.deepEqual(errors, [], 'Unhandled browser errors')
    console.log('PASS browser:', name)
  } catch (error) {
    console.error('FAIL browser:', name, errors, await page.locator('body').innerText())
    throw error
  } finally {
    await context.close()
  }
}
async function settled(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
}
async function folders(page, method, failure) {
  let attempts = 0
  let failed = true
  const rows = [
    { folderId: 1, folderName: 'Trips', sortOrder: 0, ownerUsername: 'ALICE', canEdit: true },
  ]
  await page.route('**/api/events?*', (route) => json(route, { items: [], groups: [] }))
  await page.route('**/api/folders', (route) => {
    if (route.request().method() === 'GET') return json(route, rows)
    assert.equal(route.request().method(), method)
    attempts++
    if (failed) return fail(route, failure)
    if (method === 'POST') return json(route, { folderId: 2 })
    if (method === 'DELETE') rows.splice(0)
    return json(route, { ok: true })
  })
  await page.goto(origin + '/my-albums')
  await page.getByText('Trips', { exact: true }).waitFor()
  return {
    attempts: () => attempts,
    recover: () => {
      failed = false
    },
  }
}
try {
  browser =
    process.env.CLIENT_TEST_ENGINE === 'webkit'
      ? await webkit.launch({ headless: true })
      : await chromium.launch({
          ...(process.env.CLIENT_TEST_BROWSER_PATH
            ? { executablePath: process.env.CLIENT_TEST_BROWSER_PATH }
            : { channel: 'chrome' }),
          headless: true,
        })
  console.log('Client recovery browser:', browser.version())
  await clientBoundaryRecoveryChecks({ scenario, origin, json, settled })
  await albumDestinationChecks({ scenario, origin, json, settled })
  await peoplePickerChecks({ scenario, origin, json, settled })
  await peopleControllerChecks({ scenario, origin, json, settled })
  await maintainabilityChecks({ scenario, origin, json, settled })
  await processingProgressChecks({ scenario, origin, json, settled })
  await galleryNavigationChecks({ scenario, origin, json, settled })
  await photoGridCapabilityChecks({ scenario, origin, json, settled })
  await selectionLayoutChecks({ scenario, origin, json, settled, person })
  await galleryStatusChecks({ scenario, origin, json, settled })
  await reportMapChecks({ scenario, origin, json, costData })
  await uploadPickerChecks({ scenario, origin })
  await sharingPanelChecks({ scenario, origin, json, settled })
  await galleryMaintainabilityChecks({ scenario, origin, json, settled })
  await photoViewerChecks({ scenario, origin, json, settled })
  await accessPanelChecks({ scenario, origin, json, settled })
  await identityActivityChecks({ scenario, origin, json, settled })
  await scenario('Scrolling search requests nearby photo previews in batches', async (page) => {
    const results = Array.from({ length: 50 }, (_, i) => ({
      photoId: i + 1,
      eventId: 7,
      sourceFilename: 'Photo ' + (i + 1),
      aiDescription: null,
      caption: null,
      thumbnailUrl: '/api/images?batch=1&path=thumbnails/' + (i + 1) + '.png',
    }))
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    )
    const batches = []
    await page.route('**/api/search?*', (route) =>
      json(route, {
        results: results.map((r) => ({ ...r, scores: { reranker_score: 0.987 } })),
        count: 50,
        source: 'semantic',
      }),
    )
    await page.route('**/api/images/batch', async (route) => {
      const paths = route.request().postDataJSON().paths
      batches.push(paths)
      const stream = previewBatchStream(
        paths,
        async () => new Response(pixel, { headers: { 'Content-Type': 'image/png' } }),
      )
      await route.fulfill({
        contentType: PREVIEW_CONTENT_TYPE,
        body: Buffer.from(await new Response(stream).arrayBuffer()),
      })
    })
    await page.addInitScript(() =>
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.dataset.previewBatch = 'true'
      }),
    )
    await page.goto(origin + '/search?q=photos')
    await page.addStyleTag({
      content:
        '.aspect-square{aspect-ratio:1}.w-full{width:100%}.h-full{height:100%}.overflow-hidden{overflow:hidden}.photo-card{margin:0;padding:0;box-sizing:border-box}',
    })
    const last = page.getByAltText('Photo 50', { exact: true })
    await page.locator('img[alt="Photo 1"][data-thumbnail-state="loaded"]').waitFor()
    for (const gap of [7, 1]) {
      await page.locator('.photo-grid').evaluate((el, value) => {
        el.style.setProperty('--photo-gap', `${value}px`)
        window.dispatchEvent(new Event('resize'))
      }, gap)
      await settled(page)
      const measured = await page.locator('.photo-grid').evaluate((el) => {
        const rows = [...el.querySelectorAll('.photo-grid-layout')]
        const a = rows[0].getBoundingClientRect()
        const b = rows[1].getBoundingClientRect()
        const cards = rows[0].querySelectorAll('.photo-tile')
        return {
          vertical: b.top - a.bottom,
          horizontal:
            cards[1].getBoundingClientRect().left - cards[0].getBoundingClientRect().right,
        }
      })
      assert.ok(Math.abs(measured.vertical - gap) < 0.1, JSON.stringify(measured))
      assert.ok(Math.abs(measured.horizontal - gap) < 0.1, JSON.stringify(measured))
    }
    assert.equal(await last.count(), 0)
    assert.doesNotMatch(
      await page.locator('main').innerText(),
      /Relevance:|Score unavailable|Higher scores|0\.987/,
    )
    assert.ok(batches.some((paths) => paths.length > 1))
    assert.ok(!batches.flat().includes('thumbnails/50.png'))
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
    await page.locator('img[alt="Photo 50"][data-thumbnail-state="loaded"]').waitFor()
    assert.ok(batches.flat().includes('thumbnails/50.png'))
  })
  await scenario(
    'Costs load in a fresh device context after leaving an in-flight refresh',
    async (page) => {
      costRefresh = { reads: 0, posts: 0, done: false, disconnected: false }
      await page.goto(origin + '/costs')
      await page.getByText('$20.00', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByRole('button', { name: 'Refreshing…', exact: true }).waitFor()
      await waitUntil(() => costRefresh.posts === 1)
      // A real navigation destroys the document and closes its pending HTTP request.
      await page.goto('about:blank')
      await waitUntil(() => costRefresh.disconnected)
      costRefresh.finish()
      const otherDevice = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
      })
      try {
        const otherPage = await otherDevice.newPage()
        const errors = []
        otherPage.on('pageerror', (error) => errors.push(error.message))
        await otherPage.goto(origin + '/costs')
        await otherPage.getByText('$21.00', { exact: true }).waitFor()
        assert.equal(await otherPage.getByRole('alert').count(), 0)
        assert.deepEqual(errors, [])
        assert.equal(costRefresh.posts, 1, 'Opening another device must not start another refresh')
        assert.ok(costRefresh.reads >= 2)
      } finally {
        await otherDevice.close()
      }
      await page.goto(origin + '/costs')
      await page.getByText('$21.00', { exact: true }).waitFor()
      assert.equal(costRefresh.posts, 1)
      costRefresh = undefined
    },
  )
  for (const mode of modes) {
    await scenario(`folder create preserves input after ${mode} and recovers`, async (page) => {
      const api = await folders(page, 'POST', mode)
      await page.getByRole('button', { name: 'New Folder', exact: true }).click()
      await page.getByPlaceholder('Folder name', { exact: true }).fill('Summer')
      await page.getByRole('button', { name: 'Create folder', exact: true }).click()
      await page.getByRole('alert').waitFor()
      assert.equal(
        await page.getByPlaceholder('Folder name', { exact: true }).inputValue(),
        'Summer',
      )
      assert.equal(api.attempts(), 1, 'Writes must not retry automatically')
      api.recover()
      await page.getByRole('button', { name: 'Create folder', exact: true }).click()
      await page.getByText('Summer', { exact: true }).waitFor()
      assert.equal(api.attempts(), 2)
    })
  }
  await scenario('folder rename stays editable after HTML 502 and recovers', async (page) => {
    const api = await folders(page, 'PATCH', 'html')
    await page.getByRole('button', { name: 'Folder actions for Trips' }).click()
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    const input = page.getByRole('textbox')
    await input.fill('Renamed')
    await page.getByRole('button', { name: 'Save folder name' }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await input.inputValue(), 'Renamed')
    assert.equal(api.attempts(), 1)
    api.recover()
    await page.getByRole('button', { name: 'Save folder name' }).click()
    await page.getByText('Renamed', { exact: true }).waitFor()
    assert.equal(await input.count(), 0)
  })
  await scenario('folder deletion preserves data on network failure and recovers', async (page) => {
    const api = await folders(page, 'DELETE', 'network')
    page.on('dialog', (dialog) => dialog.accept())
    const remove = async () => {
      await page.getByRole('button', { name: 'Folder actions for Trips' }).click()
      await page.getByRole('button', { name: 'Delete folder', exact: true }).click()
    }
    await remove()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByText('Trips', { exact: true }).count(), 1)
    assert.equal(api.attempts(), 1)
    api.recover()
    await remove()
    await page.getByText('Trips', { exact: true }).waitFor({ state: 'hidden' })
    assert.equal(api.attempts(), 2)
  })
  await scenario('pending folder creation blocks duplicate submission', async (page) => {
    let attempts = 0
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    await page.route('**/api/events?*', (route) => json(route, { items: [], groups: [] }))
    await page.route('**/api/folders', async (route) => {
      if (route.request().method() === 'GET') return json(route, [])
      attempts++
      await pending
      return json(route, { folderId: 2 })
    })
    await page.goto(origin + '/my-albums')
    await page.getByRole('button', { name: 'New Folder', exact: true }).click()
    await page.getByPlaceholder('Folder name', { exact: true }).fill('Summer')
    const save = page.getByRole('button', { name: 'Create folder', exact: true })
    const request = page.waitForRequest((request) => request.method() === 'POST')
    await save.evaluate((button) => {
      button.click()
      button.click()
    })
    await request
    assert.equal(await save.isDisabled(), true)
    assert.equal(attempts, 1)
    release()
    await page.getByText('Summer', { exact: true }).waitFor()
    assert.equal(attempts, 1)
  })
  for (const mode of ['network', 'html', 'malformed', 'shape']) {
    await scenario(
      `People ${mode} failure offers Retry and clears error after success`,
      async (page) => {
        let recovered = false
        await page.route('**/api/people/*', (route) => {
          if (recovered) return json(route, person())
          return mode === 'shape' ? json(route, { person: {}, faces: null }) : fail(route, mode)
        })
        await page.goto(origin + '/people/' + personId)
        await page.getByRole('button', { name: 'Retry', exact: true }).waitFor()
        assert.equal(await page.getByText(/This person was merged/).count(), 0)
        recovered = true
        await page.getByRole('button', { name: 'Retry', exact: true }).click()
        await page.getByRole('heading', { name: 'Alice', exact: true }).waitFor()
        assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 0)
      },
    )
  }
  await scenario('genuine People 404 does not poison a different person ID', async (page) => {
    await page.route('**/api/people/*', (route) =>
      route.request().url().endsWith(personId)
        ? json(route, { error: 'Not found' }, 404)
        : json(route, person('22222222-2222-4222-8222-222222222222', 'Bob')),
    )
    await page.goto(origin + '/people/' + personId)
    await page.getByText(/This person was merged/).waitFor()
    await page.getByRole('button', { name: 'Change person' }).click()
    await page.getByRole('heading', { name: 'Bob', exact: true }).waitFor()
    assert.equal(await page.getByText(/This person was merged/).count(), 0)
  })
  await scenario(
    'Select all faces selects only the loaded page and can be cleared',
    async (page) => {
      const data = person()
      data.more = true
      data.person.photoCount = 3
      data.faces = [1, 2].map((faceId) => ({
        faceId,
        photoId: faceId,
        hasCrop: false,
        status: 'confirmed',
      }))
      await page.route('**/api/people*', (route) => json(route, { named: [], more: false }))
      await page.route('**/api/people/*', (route) => json(route, data))
      await page.goto(origin + '/people/' + personId)
      await page.getByRole('button', { name: 'Select faces', exact: true }).click()
      await page.getByRole('button', { name: 'Actions', exact: true }).click()
      await page.getByRole('button', { name: 'Select all on this page', exact: true }).click()
      assert.equal(
        await page.getByRole('checkbox', { name: 'Select face 1', exact: true }).isChecked(),
        true,
      )
      assert.equal(
        await page.getByRole('checkbox', { name: 'Select face 2', exact: true }).isChecked(),
        true,
      )
      assert.equal(
        await page.getByRole('checkbox', { name: 'Select face 3', exact: true }).count(),
        0,
      )
      assert.equal(
        await page
          .getByRole('button', { name: 'Select all on this page', exact: true })
          .isDisabled(),
        true,
      )
      if (!(await page.getByRole('button', { name: 'Clear', exact: true }).isVisible()))
        await page.getByRole('button', { name: 'Actions', exact: true }).click()
      await page.getByRole('button', { name: 'Clear', exact: true }).click()
      assert.equal(
        await page.getByRole('checkbox', { name: 'Select face 1', exact: true }).isChecked(),
        false,
      )
      assert.equal(
        await page.getByRole('checkbox', { name: 'Select face 2', exact: true }).isChecked(),
        false,
      )
    },
  )
  await scenario(
    'People accepts PostgreSQL BIGINT identifiers and normalized UUID casing',
    async (page) => {
      const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const data = person(id)
      data.person.coverFaceId = '7'
      data.person.photoCount = 1
      data.faces = [{ faceId: '7', photoId: 1, eventId: 7, hasCrop: false, status: 'confirmed' }]
      await page.route('**/api/people/*', (route) => json(route, data))
      await page.route('**/api/faces/*/crop', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        }),
      )
      await page.goto(origin + '/people/' + id.toUpperCase())
      await page.getByRole('heading', { name: 'Alice', exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 0)
    },
  )
  await scenario(
    'late response for the previous person cannot replace the current person',
    async (page) => {
      let release
      const pending = new Promise((resolve) => {
        release = resolve
      })
      await page.route('**/api/people/*', async (route) => {
        if (route.request().url().endsWith(personId)) {
          await pending
          return json(route, person())
        }
        return json(route, person('22222222-2222-4222-8222-222222222222', 'Bob'))
      })
      await page.goto(origin + '/people/' + personId)
      await page.getByRole('button', { name: 'Change person' }).click()
      await page.getByRole('heading', { name: 'Bob', exact: true }).waitFor()
      release()
      await settled(page)
      assert.equal(await page.getByRole('heading', { name: 'Alice', exact: true }).count(), 0)
    },
  )
  for (const mode of ['empty', 'populated', 'recovery']) {
    await scenario(`People history ${mode} accepts its array contract`, async (page) => {
      let recovered = false
      await page.route('**/api/people?*', (route) =>
        json(route, {
          named: [],
          unnamed: [],
          hidden: [],
          reviewCount: 0,
          lowerConfidenceCount: 0,
          unknownCount: 0,
          ignoredCount: 0,
          unnamedCount: 0,
          peopleCount: 0,
        }),
      )
      await page.route('**/api/people/settings', (route) =>
        json(route, { enabled: true, shareNames: false }),
      )
      await page.route('**/api/people/history', (route) =>
        json(
          route,
          mode === 'recovery' && !recovered
            ? { malformed: true }
            : mode === 'empty'
              ? []
              : [
                  {
                    id: '7',
                    summary: 'Named Alice',
                    createdAt: '2026-01-01T00:00:00Z',
                    undoneAt: null,
                    canUndo: true,
                  },
                ],
        ),
      )
      await page.goto(origin + '/people?tab=history')
      if (mode === 'recovery') {
        await page.getByRole('alert').waitFor()
        recovered = true
        await page.getByRole('button', { name: 'Retry', exact: true }).click()
      }
      await page
        .getByText(mode === 'empty' ? 'No changes yet.' : 'Named Alice', { exact: true })
        .waitFor()
      assert.equal(await page.getByRole('alert').count(), 0)
    })
  }
  for (const returning of [false, true]) {
    await scenario(
      `${returning ? 'photo return restores depth/scroll' : 'ordinary album entry fetches one page'} without a cached snapshot`,
      async (page) => {
        const calls = []
        await page.addInitScript((returning) => {
          sessionStorage.setItem('photo-pages:ALICE:7:', '5000')
          sessionStorage.setItem(
            'gallery-position-v1:ALICE:position:/events/7',
            JSON.stringify({ y: 1600 }),
          )
          if (returning)
            sessionStorage.setItem(
              'gallery-position-v1:ALICE:restore-once',
              JSON.stringify('/events/7'),
            )
        }, returning)
        await photoApi(page, calls)
        await page.goto(origin + '/events/7')
        await page
          .getByText(returning ? '5088 files shown' : '96 files shown', { exact: true })
          .first()
          .waitFor({ state: 'attached' })
        await settled(page)
        // A fresh page has no in-memory snapshot; 5,000 remembered items exceed its cap.
        assert.equal(calls.filter((cursor) => cursor !== null).length, returning ? 52 : 0)
        assert.equal(await page.evaluate(() => scrollY), returning ? 1600 : 0)
      },
    )
  }
  for (const mode of ['ordinary', 'expired']) {
    await scenario(
      `album ${mode} navigation handles an existing pagination snapshot`,
      async (page) => {
        const calls = []
        await page.addInitScript(() => {
          sessionStorage.setItem('photo-pages:ALICE:7:', '288')
          sessionStorage.setItem(
            'gallery-position-v1:ALICE:restore-once',
            JSON.stringify('/events/7'),
          )
        })
        await photoApi(page, calls)
        await page.goto(origin + '/events/7')
        await page
          .getByText('288 files shown', { exact: true })
          .first()
          .waitFor({ state: 'attached' })
        await page.getByRole('button', { name: 'Open photo-1.jpg', exact: true }).click()
        await page.getByRole('button', { name: 'Return to album' }).waitFor()
        calls.length = 0
        if (mode === 'expired')
          await page.evaluate(() => {
            const original = Date.now
            Date.now = () => original() + 31000
          })
        await page
          .getByRole('button', {
            name: mode === 'expired' ? 'Return to album' : 'Open album normally',
            exact: true,
          })
          .click()
        await page
          .getByText(mode === 'expired' ? '288 files shown' : '96 files shown', { exact: true })
          .first()
          .waitFor({ state: 'attached' })
        await settled(page)
        assert.equal(calls.filter((cursor) => cursor !== null).length, mode === 'expired' ? 2 : 0)
      },
    )
  }
  await scenario(
    'photo return revalidates access before displaying a cached album',
    async (page) => {
      let denied = false
      const calls = []
      await photoApi(page, calls, () => denied)
      await page.goto(origin + '/events/7')
      const link = page.getByRole('button', { name: 'Open photo-1.jpg', exact: true })
      await link.waitFor()
      await link.click()
      await page.getByRole('button', { name: 'Return to album' }).waitFor()
      denied = true
      await page.getByRole('button', { name: 'Return to album' }).click()
      await page.getByText('Access denied', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: /^Open photo-/ }).count(), 0)
    },
  )
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}

async function photoApi(page, calls, denied = () => false) {
  await page.route('**/api/events/7?*', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')
    calls.push(cursor)
    if (denied()) return json(route, { error: 'Access denied' }, 403)
    const start = Number(cursor || 0)
    const end = Math.min(10000, start + 96)
    return json(route, {
      items: Array.from({ length: end - start }, (_, i) => ({
        photoId: start + i + 1,
        sourceFilename: `photo-${start + i + 1}.jpg`,
        thumbnailUrl: null,
        aspectRatio: 1,
        mediaType: 'image',
        favorite: false,
        eventId: 7,
      })),
      nextCursor: String(end),
    })
  })
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for fixture state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
