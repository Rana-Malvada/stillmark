/** Fault injection against actual mounted React components; no production traffic or writes. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium, webkit } from 'playwright-core'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await build({
  entryPoints: [path.join(root, 'scripts/verification/frontend-recovery/fixture.jsx')],
  loader: { '.css': 'empty' },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  plugins: [
    {
      name: 'framework-boundary',
      setup(b) {
        b.onResolve(
          {
            filter:
              /^(next\/(link|navigation)|.*\/(auth-provider|upload-provider|theme-provider))$/,
          },
          () => ({ path: path.join(root, 'scripts/verification/client-recovery/stubs.jsx') }),
        )
        b.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: 'dynamic', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export default function dynamic(){return ()=>null}',
        }))
      },
    },
  ],
})
let videoHandshakeCalls = 0
const server = createServer((req, res) => {
  if (req.url === '/api/videos/1/playlist') {
    // Use a real pending response so native browser cancellation is exercised.
    if (++videoHandshakeCalls > 1) {
      res.writeHead(204)
      res.end()
    }
  } else if (req.url === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript')
    res.end(bundle.outputFiles[0].text)
  } else {
    res.setHeader('Content-Type', 'text/html')
    res.end('<div id="root"></div><script type="module" src="/fixture.js"></script>')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const browser =
  process.env.CLIENT_TEST_ENGINE === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({
        headless: true,
        executablePath:
          process.env.CLIENT_TEST_BROWSER_PATH ||
          process.env.CHROME_PATH ||
          (process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : chromium.executablePath()),
      })
const errors = []
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const search = {
  results: [],
  source: 'postgres',
  count: 0,
  people: [],
  suggestions: [],
  nextCursor: null,
}
// A valid /api/my-costs report; `n` is the compute subtotal, shown as `$n.00`.
const costs = (n) => ({
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
  subtotalUsd: n,
  asOf: '2026-11-10T19:00:00Z',
  prices: { creditUsd: 2 },
  storage: { bytes: 0, files: 0, monthlyUsd: 0 },
  transfers: { uploadedBytes: 0, requestedDownloadBytes: 0 },
  timeZone: 'America/New_York',
  periodEnd: '2026-11-10',
  trackingStarted: null,
})
const pageFor = async (kind, handler, suffix = '') => {
  const page = await browser.newPage()
  page.on('pageerror', (e) => errors.push(`${kind}: ${e.message}`))
  page.setDefaultTimeout(5000)
  await page.route('**/api/**', (route) =>
    route.request().url().includes('/api/events?')
      ? json(route, { items: [], nextCursor: null })
      : handler(route),
  )
  await page.goto(`${base}/?probe=${kind}${suffix}`)
  return page
}
const waitText = async (page, text) => page.getByText(text, { exact: false }).first().waitFor()
let checks = 0
try {
  for (const [kind, message] of [
    ['search', 'Search failed'],
    ['trash', 'Unable to load Trash'],
    ['location', 'Could not load locations'],
    ['defaults', 'Could not load allowances'],
    ['costs', 'Could not load costs'],
  ]) {
    const page = await pageFor(kind, (route) => json(route, {}), '&q=test')
    if (kind === 'location') await page.getByText('Set missing locations', { exact: true }).click()
    await waitText(page, message)
    assert.equal(errors.length, 0, errors.join('\n'))
    await page.close()
    checks++
  }
  {
    let calls = 0
    const page = await pageFor(
      'search',
      (route) =>
        json(
          route,
          ++calls === 1 ? { error: 'Temporary failure' } : search,
          calls === 1 ? 503 : 200,
        ),
      '&q=test',
    )
    await waitText(page, 'Temporary failure')
    await page.getByRole('button', { name: 'Run search' }).click()
    await page.waitForFunction(() => !document.querySelector('[aria-label="Searching"]'))
    assert.equal(calls, 2, 'same-query submit must retry')
    assert.equal(await page.getByText('Temporary failure').count(), 0)
    await page.close()
    checks++
  }
  {
    const page = await pageFor(
      'search',
      (route) => json(route, { ...search, people: [{ personId: 'person', name: 'Alice' }] }),
      '&person=person&type=photos',
    )
    await page.getByRole('button', { name: 'Remove Alice from search' }).click()
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="People in this search"]'),
    )
    assert.equal(await page.getByRole('textbox', { name: 'Search your library' }).inputValue(), '')
    assert.equal(new URL(page.url()).searchParams.has('person'), false)
    await page.close()
    checks++
  }
  for (const kind of ['date', 'labels']) {
    let writes = 0
    let reads = 0
    const page = await browser.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    // Speed only the production operation deadline; no component or fetch implementation is stubbed.
    await page.addInitScript(() => {
      const timer = window.setTimeout
      window.setTimeout = (fn, ms, ...args) => timer(fn, ms === 45000 ? 100 : ms, ...args)
    })
    await page.route('**/api/**', (route) => {
      if (route.request().method() === 'PATCH') {
        writes++
        return
      }
      reads++
      return json(route, {})
    })
    await page.goto(`${base}/?probe=${kind}`)
    if (kind === 'date') {
      await page.getByRole('button', { name: 'Set photo dates', exact: true }).click()
      await page.locator('input[type=date]').fill('2026-01-01')
      await page.getByText('Apply date', { exact: true }).click()
    } else {
      await page.getByText('Edit caption & tags', { exact: true }).click()
      await page.getByText('Save', { exact: true }).click()
    }
    await waitText(page, 'The result could not be confirmed')
    assert.equal(writes, 1, 'ambiguous write must not automatically replay')
    if (kind === 'labels') assert.equal(reads, 1, 'read saved labels after uncertain write')
    await page.keyboard.press('Escape')
    assert.equal(
      await page.locator('dialog[open]').count(),
      0,
      'editor must recover from stalled response',
    )
    await page.close()
    checks++
  }
  {
    // Deliberately make fetch ignore cancellation for the superseded read: the panel's own guard must
    // still protect state. The live cost screen offers Refresh only once a report is shown, so the
    // superseded read is the reload after a first refresh, overtaken by a second refresh.
    const page = await browser.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript(() => {
      const request = window.fetch
      window.fetch = (url, init) =>
        request(
          url,
          typeof url === 'string' && url === '/api/my-costs'
            ? { ...init, signal: undefined }
            : init,
        )
    })
    let release
    let calls = 0
    await page.route('**/api/costs', (route) => json(route, { asOf: 'new' }))
    await page.route('**/api/my-costs', async (route) => {
      if (++calls === 1) return json(route, costs(5))
      if (calls === 2) {
        await new Promise((resolve) => {
          release = resolve
        })
        return json(route, costs(111))
      }
      return json(route, costs(999))
    })
    await page.goto(`${base}/?probe=costs`)
    await waitText(page, '$5.00')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.waitForFunction(() => document.body.textContent.includes('Showing previous report'))
    assert.equal(calls, 2, 'first refresh starts the read that will be superseded')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await waitText(page, '$999.00')
    assert.equal(calls, 3, 'second refresh reloads the report')
    release()
    await page.waitForTimeout(100)
    assert.equal(
      await page.getByText('$111.00').count(),
      0,
      'late superseded read must not replace refreshed costs',
    )
    await waitText(page, '$999.00')
    await page.close()
    checks++
  }
  {
    const page = await browser.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript(() => {
      const timer = window.setTimeout
      window.setTimeout = (fn, ms, ...args) => timer(fn, ms === 45000 ? 100 : ms, ...args)
    })
    videoHandshakeCalls = 0
    await page.route('**/original.mp4', (route) => route.abort())
    await page.goto(`${base}/?probe=video`)
    await page.getByRole('button', { name: 'Playback interrupted · Retry' }).click()
    await page.waitForFunction(
      () => document.querySelector('video')?.dataset.playbackMode === 'original',
    )
    assert.equal(
      videoHandshakeCalls,
      2,
      'handshake timeout offers retry; 204 preserves original-video fallback',
    )
    await page.close()
    checks++
  }
  for (const [kind, payload] of [
    [
      'search',
      {
        ...search,
        results: [
          {
            photoId: 1,
            eventId: 2,
            sourceFilename: 'fixture.jpg',
            aiDescription: null,
            caption: null,
            thumbnailUrl: null,
          },
        ],
      },
    ],
    [
      'trash',
      {
        files: [
          {
            photoId: 1,
            filename: 'fixture.jpg',
            albumName: 'Album',
            expiresAt: '2026-12-01T00:00:00Z',
          },
        ],
        hasMore: false,
      },
    ],
    ['location', { eligible: 3, changes: [] }],
    ['defaults', { uploads: 50, bytes: 1073741824 }],
    ['costs', costs(8)],
  ]) {
    const page = await pageFor(kind, (route) => json(route, payload), '&q=test')
    if (kind === 'location') await page.getByText('Set missing locations', { exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal(
      await page.locator('[role="alert"]').count(),
      0,
      `${kind}: valid route payload accepted`,
    )
    assert.equal(errors.length, 0, errors.join('\n'))
    await page.close()
    checks++
  }
  {
    let valid = false
    const overview = {
      named: [],
      unnamed: [],
      hidden: [],
      reviewCount: 0,
      lowerConfidenceCount: 0,
      unknownCount: 0,
      ignoredCount: 0,
      unnamedCount: 0,
      peopleCount: 0,
      more: false,
      nextCursor: null,
    }
    const page = await pageFor('people', (route) =>
      json(
        route,
        route.request().url().includes('/settings')
          ? { enabled: true, shareNames: false }
          : valid
            ? overview
            : {},
      ),
    )
    await waitText(page, 'Unable to load people')
    valid = true
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[role="alert"]'))
    await page.close()
    checks++
  }
  {
    let posts = 0
    let reads = 0
    const page = await pageFor('people-write', (route) => {
      if (route.request().method() === 'PATCH') {
        posts++
        return route.abort('failed')
      }
      reads++
      return json(route, { name: 'New name' })
    })
    await page.getByRole('button', { name: 'Change person' }).click()
    await waitText(page, 'The result could not be confirmed')
    await waitText(page, 'New name')
    assert.equal(posts, 1, 'lost correction acknowledgement must not replay')
    assert.equal(reads, 1, 'uncertain correction reloads current data')
    assert.equal(await page.getByRole('button', { name: 'Change person' }).isEnabled(), true)
    await page.close()
    checks++
  }
  {
    let posts = 0
    let reads = 0
    const page = await pageFor('activity', (route) => {
      if (route.request().method() === 'POST') {
        posts++
        return route.abort('failed')
      }
      reads++
      return json(route, {
        summary: { pending_sync: posts ? 9876 : 0 },
        asOf: new Date().toISOString(),
        sync: null,
        uploads: [],
        failures: [],
        cleanup: [],
      })
    })
    await page.getByRole('button', { name: 'Sync Search', exact: true }).click()
    await waitText(page, 'The result could not be confirmed')
    await waitText(page, '9876')
    assert.equal(posts, 1, 'Activity must not replay an ambiguous action')
    assert.ok(reads >= 2, 'Activity must reread authoritative status after an ambiguous action')
    assert.equal(
      await page.getByRole('button', { name: 'Sync Search', exact: true }).isEnabled(),
      true,
    )
    await page.close()
    checks++
  }
  {
    let posts = 0
    const own = {
      folderId: 71,
      folderName: 'Recovered folder',
      ownerUsername: 'ALICE',
      canSelect: true,
      canEdit: true,
    }
    const page = await pageFor('upload-folder', (route) => {
      if (!route.request().url().includes('/api/folders')) return json(route, { ready: true })
      if (route.request().method() === 'POST') {
        posts++
        return route.abort('failed')
      }
      return json(route, posts ? [own] : [])
    })
    await page.locator('input[type=file]').evaluate((input) => {
      input.removeAttribute('webkitdirectory')
      const files = new DataTransfer()
      files.items.add(new File(['fixture'], 'fixture.jpg', { type: 'image/jpeg' }))
      input.files = files.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.getByRole('button', { name: 'New folder', exact: true }).click()
    await page.getByLabel('New folder name').fill('Recovered folder')
    await page.getByRole('button', { name: 'Create folder', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#upload-folder')?.value === '71')
    assert.equal(posts, 1, 'lost folder acknowledgment must be reconciled without duplicate POST')
    assert.equal(await page.locator('#upload-folder option[value="71"]').count(), 1)
    assert.equal(await page.getByRole('button', { name: 'Create folder', exact: true }).count(), 0)
    await page.close()
    checks++
  }

  const activityReport = (target, next = null) => ({
    totals: { users: 1, photos: 1 },
    daily: [],
    users: [
      {
        username: 'ALICE',
        displayName: 'Alice',
        email: null,
        events: 1,
        last_seen: '2026-11-21T12:00:00Z',
      },
    ],
    events: [
      {
        event_id: target,
        username: 'ALICE',
        displayName: 'Alice',
        email: null,
        kind: 'photo_view',
        target,
        source: 'browser',
        occurred_at: '2026-11-21T12:00:00Z',
        details: {},
      },
    ],
    next,
  })
  const userActivityHandler = (handler) => (route) =>
    new URL(route.request().url()).pathname === '/api/user-activity/identity'
      ? json(route, [])
      : handler(route)
  for (const [failure, status] of [
    [{}, 200],
    [{ error: 'Temporary activity failure' }, 503],
  ]) {
    let calls = 0
    const page = await pageFor(
      'user-activity',
      userActivityHandler((route) =>
        ++calls === 1
          ? json(route, failure, status)
          : json(route, activityReport('Recovered activity')),
      ),
    )
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Apply / Refresh' }).isEnabled(), true)
    await page.getByRole('button', { name: 'Apply / Refresh' }).click()
    await page.getByRole('cell', { name: 'Recovered activity', exact: true }).waitFor()
    assert.equal(await page.getByRole('alert').count(), 0)
    assert.equal(calls, 2)
    await page.close()
    checks++
  }
  {
    let calls = 0
    const page = await browser.newPage()
    page.on('pageerror', (e) => errors.push(`user-activity timeout: ${e.message}`))
    page.setDefaultTimeout(5000)
    await page.addInitScript(() => {
      const timer = window.setTimeout
      window.setTimeout = (fn, ms, ...args) => timer(fn, ms === 45000 ? 100 : ms, ...args)
      const realFetch = window.fetch.bind(window)
      window.activityAborted = 0
      window.fetch = (url, init) => {
        if (String(url).startsWith('/api/user-activity?'))
          init.signal.addEventListener('abort', () => window.activityAborted++, { once: true })
        return realFetch(url, init)
      }
    })
    await page.route(
      '**/api/**',
      userActivityHandler((route) => {
        if (++calls === 1) return
        return json(route, activityReport('After deadline'))
      }),
    )
    await page.goto(`${base}/?probe=user-activity`)
    await waitText(page, 'The request timed out. Please try again.')
    assert.equal(
      await page.evaluate(() => window.activityAborted),
      1,
      'deadline must abort transport',
    )
    await page.getByRole('button', { name: 'Apply / Refresh' }).click()
    await page.getByRole('cell', { name: 'After deadline', exact: true }).waitFor()
    assert.equal(calls, 2)
    await page.close()
    checks++
  }
  {
    const requests = []
    const cursor = { time: '2026-11-20T12:00:00Z', id: '00000000-0000-4000-8000-000000000001' }
    const page = await pageFor(
      'user-activity',
      userActivityHandler((route) => {
        const query = new URL(route.request().url()).searchParams
        requests.push(Object.fromEntries(query))
        return json(
          route,
          query.has('before')
            ? activityReport('Older activity')
            : activityReport('Current activity', cursor),
        )
      }),
    )
    await page.getByRole('cell', { name: 'Current activity', exact: true }).waitFor()
    await page.getByLabel('Date range').selectOption('7')
    await page.getByLabel('Activity type').selectOption('photo_view')
    await page.getByRole('button', { name: 'Load older activity' }).click()
    await page.getByRole('cell', { name: 'Older activity', exact: true }).waitFor()
    assert.equal(
      requests[1].days,
      '30',
      'pagination must use applied filters, not unsubmitted edits',
    )
    assert.equal(requests[1].kind, '')
    assert.equal(requests[1].beforeId, cursor.id)
    assert.equal(
      await page.getByText('Current activity', { exact: true }).count(),
      2,
      'existing mobile and desktop rows retained',
    )
    await page.getByRole('button', { name: 'Apply / Refresh' }).click()
    await page.waitForFunction(
      () =>
        document.querySelector('select[aria-label="Date range"]')?.value === '7' &&
        !document.querySelector('button.primary-button')?.disabled,
    )
    assert.equal(requests[2].days, '7')
    assert.equal(requests[2].kind, 'photo_view')
    assert.equal(requests[2].before, undefined)
    assert.equal(await page.getByText('Older activity', { exact: true }).count(), 0)
    await page.close()
    checks++
  }
  {
    let calls = 0
    let oldRequest
    const page = await pageFor(
      'user-activity',
      userActivityHandler((route) => {
        if (++calls === 1) {
          oldRequest = route
          return
        }
        return json(route, activityReport('Reopened current activity'))
      }),
    )
    await page.getByRole('button', { name: 'Close activity fixture' }).click()
    await page.getByRole('button', { name: 'Open activity fixture' }).click()
    await page.getByRole('cell', { name: 'Reopened current activity', exact: true }).waitFor()
    await json(oldRequest, activityReport('Stale closed activity'))
    await page.waitForTimeout(100)
    assert.equal(await page.getByText('Stale closed activity', { exact: true }).count(), 0)
    assert.equal(await page.getByText('Reopened current activity', { exact: true }).count(), 2)
    assert.equal(calls, 2)
    await page.close()
    checks++
  }
  assert.deepEqual(errors, [])
  console.log(
    `PASS: ${checks} frontend response, retry, reset, timeout, and race scenarios; no uncaught render errors.`,
  )
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
