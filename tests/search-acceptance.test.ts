import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createSearchDatabase } from './fixtures/search-database'
import { acceptanceCases, seedAcceptance } from './fixtures/search-acceptance'
import { createServer } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { interpretationRequest } from '@/lib/search/search-interpretation-request'
import { deployment } from '../config/deployment.mjs'

const state = vi.hoisted(() => ({
  db: null as import('@electric-sql/pglite').PGlite | null,
  user: 'SEARCH_TEST',
  tail: Promise.resolve(),
  live: false,
}))
vi.mock('@/lib/identity/auth', () => ({
  requireAuth: async () => ({ username: state.user }),
  getCallerIdentity: async () => ({ username: state.user, role: 'user' }),
}))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: vi.fn() }))
vi.mock('@/lib/postgres', () => ({
  getDatabaseIdentity: async () => ({
    username: state.user,
    mainAdmin: false,
    adminRead: false,
    adminWrite: false,
    canWrite: true,
    accessManager: false,
  }),
  pgQuery: async (sql: string, params: unknown[] = []) => {
    const username = state.user
    // PGlite uses one connection; serialize request transactions while preserving RLS.
    const work = state.tail.then(async () => {
      await state.db!.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
      try {
        await state.db!.query(
          "SELECT set_config('photos.username',$1,true),set_config('photos.can_write','true',true)",
          [username],
        )
        const result = await state.db!.query(sql, params)
        await state.db!.exec('COMMIT')
        return result.rows
      } catch (error) {
        await state.db!.exec('ROLLBACK')
        throw error
      }
    })
    state.tail = work.then(
      () => {},
      () => {},
    )
    return work
  },
}))
vi.mock('@/lib/snowflake', () => ({
  querySnowflake: vi.fn(),
  querySnowflakeStorage: vi.fn(),
  getSnowflakeBaseUrl: () => {
    throw Error('Unexpected semantic provider call')
  },
  getRestApiAuthHeader: () => '',
}))
const intentMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/search/search-intent', async (original) => ({
  ...(await original<typeof import('@/lib/search/search-intent')>()),
  interpretSearch: intentMock,
}))
import { validateIntent } from '@/lib/search/search-intent'
import { GET as photos } from '@/app/api/search/route'
import { GET as albums } from '@/app/api/search/events/route'

let jwt = ''
const plans = new Map<string, unknown>()
beforeAll(async () => {
  state.db = await createSearchDatabase()
  await seedAcceptance(state.db)
}, 60000)
afterAll(async () => {
  await state.tail
  await state.db?.close()
})
async function interpret(query: string, _selected: string[], kind: 'photo' | 'event') {
  let plan = plans.get(query)
  if (!plan && state.live) {
    const modelStarted = performance.now()
    const modelRequest = interpretationRequest(query, [], kind)
    if (process.env.SEARCH_EVALUATION_MODEL)
      modelRequest.model = process.env.SEARCH_EVALUATION_MODEL
    const response = await fetch(
      new URL('/api/v2/cortex/v1/messages', deployment.SNOWFLAKE_API_ORIGIN),
      {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: 'Bearer ' + jwt,
          'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(modelRequest),
      },
    )
    if (!response.ok)
      throw Error(
        'Live interpreter HTTP ' + response.status + ' ' + (await response.text()).slice(0, 2000),
      )
    const body = await response.json()
    console.log(
      'MODEL',
      modelRequest.model,
      Math.round(performance.now() - modelStarted) + 'ms',
      JSON.stringify(body.usage),
    )
    expect(body.stop_reason).toBe('end_turn')
    plan = JSON.parse(
      body.content
        .map((c: { text?: string }) => c.text ?? '')
        .join('')
        .trim()
        .replace(/^```(?:json)?\s*|\s*```$/g, ''),
    )
    plans.set(query, plan)
  } else if (!plan) {
    const fixture = acceptanceCases.find((c) => c.query === query)
    if (!fixture) throw Error('Unexpected query ' + query)
    plan = { where: fixture.where, keywords: '', clarification: null }
  }
  return {
    intent: validateIntent(plan),
    metrics: { mode: 'sonnet', elapsedMs: 1, inputTokens: 0, outputTokens: 0 },
  }
}
async function request(query: string, kind: 'photo' | 'event', cursor?: string) {
  const params = new URLSearchParams({ q: query, limit: '2' })
  if (cursor) params.set('cursor', cursor)
  const res = await (kind === 'photo' ? photos : albums)(
    new Request('http://localhost/api/search?' + params),
  )
  const body = await res.json()
  expect(res.status, query + ' cursor=' + cursor + ' ' + JSON.stringify(body)).toBe(200)
  expect(body.clarification, query + ' plan=' + JSON.stringify(plans.get(query))).toBeFalsy()
  return body
}
async function checkCorpus() {
  const failures: string[] = []
  for (const item of acceptanceCases) {
    try {
      const collected: number[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const body = await request(item.query, item.kind, cursor)
        collected.push(
          ...body.results.map(
            (r: Record<string, number>) => r[item.kind === 'photo' ? 'photoId' : 'eventId'],
          ),
        )
        cursor = body.nextCursor ?? undefined
        expect(++pages).toBeLessThan(10)
      } while (cursor)
      expect(
        collected.sort((a, b) => a - b),
        item.query + ' plan=' + JSON.stringify(plans.get(item.query)),
      ).toEqual(item.expected)
      expect(new Set(collected).size).toBe(collected.length)
      if (state.live) console.log('PASS live results:', item.query)
    } catch (error) {
      failures.push(String(error))
    }
  }
  expect(failures).toEqual([])
}
it('executes the acceptance corpus through real endpoints, permissions, interpretation plans and exact pagination', async () => {
  intentMock.mockImplementation(async (...args: Parameters<typeof interpret>) => {
    try {
      return await interpret(...args)
    } catch (e) {
      if (state.live) console.error(String(e))
      throw e
    }
  })
  await checkCorpus()
}, 60000)

it.runIf(
  process.env.SEARCH_ACCEPTANCE_LIVE === '1' || process.env.SEARCH_ACCEPTANCE_BROWSER === '1',
)(
  'live language-to-results and real browser end to end',
  async () => {
    state.live = process.env.SEARCH_ACCEPTANCE_LIVE === '1'
    if (state.live)
      jwt = execFileSync('snow', ['connection', 'generate-jwt', '-c', 'stillmark-test'], {
        encoding: 'utf8',
      }).trim()
    await state.db!.exec('DELETE FROM search_sessions')
    intentMock.mockImplementation(async (...args: Parameters<typeof interpret>) => {
      try {
        return await interpret(...args)
      } catch (e) {
        if (state.live) console.error(String(e))
        throw e
      }
    })
    await checkCorpus()
    // Clear cached results so the browser reaches the interpreter/SQL path too.
    await state.db!.exec('DELETE FROM search_sessions')
    const fixture = process.cwd() + '/scripts/verification/client-recovery/'
    const bundle = await build({
      entryPoints: [fixture + 'app.jsx'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'fixture-auth-and-router',
          setup(b) {
            b.onResolve({ filter: /^(next\/(link|navigation)|.*\/auth-provider)$/ }, () => ({
              path: fixture + 'stubs.jsx',
            }))
          },
        },
      ],
    })
    // Use the production stylesheet so card sizing/visibility is exercised too.
    const css = readdirSync('.next/static/css')
      .filter((file) => file.endsWith('.css'))
      .map((file) => readFileSync('.next/static/css/' + file, 'utf8'))
      .join('\n')
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, 'http://localhost')
        if (url.pathname === '/fixture.css') {
          res.setHeader('Content-Type', 'text/css')
          res.end(css)
          return
        }
        if (url.pathname === '/fixture.js') {
          res.setHeader('Content-Type', 'application/javascript')
          res.end(bundle.outputFiles[0].contents)
          return
        }
        if (url.pathname === '/api/search' || url.pathname === '/api/search/events') {
          // Small pages exercise the UI's actual continuation path.
          url.searchParams.set('limit', '2')
          const response = await (url.pathname.endsWith('/events') ? albums : photos)(
            new Request(url),
          )
          res.writeHead(response.status, Object.fromEntries(response.headers))
          res.end(await response.text())
          return
        }
        if (url.pathname.startsWith('/api/')) {
          res.writeHead(404).end()
          return
        }
        res.setHeader('Content-Type', 'text/html')
        res.end(
          '<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        )
      } catch (error) {
        res.writeHead(500).end(String(error))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.CLIENT_TEST_BROWSER_PATH
        ? { executablePath: process.env.CLIENT_TEST_BROWSER_PATH }
        : { channel: 'chrome' }),
    })
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
      page.setDefaultTimeout(5000)
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      for (const item of [acceptanceCases[0], acceptanceCases[3], acceptanceCases[18]]) {
        await page.goto(
          origin +
            '/search?' +
            new URLSearchParams({
              q: '',
              type: item.kind === 'event' ? 'albums' : 'photos',
            }),
        )
        await page.getByRole('textbox', { name: 'Search your library' }).fill(item.query)
        await page.getByRole('button', { name: 'Run search' }).click()
        const selector =
          item.kind === 'photo' ? '.photo-card > button > div' : 'a[href^="/events/"]'
        await page.locator(selector).first().waitFor()
        for (let i = 0; i < 4; i++) {
          const more = page.getByRole('button', { name: /show more/i })
          if ((await more.count()) && (await more.isVisible())) {
            await more.click()
            await page
              .getByRole('button', { name: 'Loading…', exact: true })
              .waitFor({ state: 'hidden' })
          } else break
        }
        if (item.kind === 'photo') {
          const names: Record<number, string> = {
            101: 'lake.jpg',
            102: 'rome.jpg',
            104: 'paris.jpg',
            105: 'fallback.heic',
            106: 'spring.jpg',
          }
          expect((await page.locator(selector).allTextContents()).sort(), item.query).toEqual(
            item.expected.map((id) => names[id]).sort(),
          )
        } else {
          const ids = await page
            .locator(selector)
            .evaluateAll((nodes) => nodes.map((n) => Number(n.getAttribute('href')!.split('/')[2])))
          expect(
            ids.sort((a, b) => a - b),
            item.query,
          ).toEqual(item.expected)
        }
      }
      expect(errors).toEqual([])
    } catch (error) {
      for (const page of browser.contexts().flatMap((context) => context.pages()))
        console.error('Browser state:', await page.locator('body').innerText())
      throw error
    } finally {
      await browser.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  240000,
)

it('rechecks ownership and revoked album access, and never broadens a provider failure', async () => {
  state.live = false
  const query = 'Photos with caption containing "sunset"'
  intentMock.mockImplementation(async (...args: Parameters<typeof interpret>) => {
    try {
      return await interpret(...args)
    } catch (e) {
      if (state.live) console.error(String(e))
      throw e
    }
  })
  expect(
    (await request(query, 'photo')).results.map((r: { photoId: number }) => r.photoId),
  ).toEqual([101])
  try {
    state.user = 'OTHER_OWNER'
    expect(
      (await request(query, 'photo')).results.map((r: { photoId: number }) => r.photoId),
    ).toEqual([109])
    state.user = 'SEARCH_TEST'
    await state.db!.exec("UPDATE events SET owner_username='OTHER_OWNER' WHERE event_id=101")
    expect((await request(query, 'photo')).results).toEqual([])
  } finally {
    state.user = 'SEARCH_TEST'
    await state.db!.exec("UPDATE events SET owner_username='SEARCH_TEST' WHERE event_id=101")
  }
  intentMock.mockRejectedValueOnce(new Error('provider unavailable'))
  const response = await photos(
    new Request(
      'http://localhost/api/search?q=' +
        encodeURIComponent('Photos with camera model equals never-seen-model'),
    ),
  )
  // A provider failure is an error, never a broadened or empty "answer", and is not
  // saved: repeating the query asks the interpreter again instead of replaying a failure.
  expect(response.status).toBeGreaterThanOrEqual(500)
  expect((await response.json()).results).toBeUndefined()
  const asked = intentMock.mock.calls.length
  await photos(
    new Request(
      'http://localhost/api/search?q=' +
        encodeURIComponent('Photos with camera model equals never-seen-model'),
    ),
  )
  expect(intentMock.mock.calls.length).toBe(asked + 1)
})
it('pages every exact match beyond the semantic candidate cap and reuses interpretation', async () => {
  await state.db!
    .exec(`INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility) VALUES(108,108,'Paging','paging','SEARCH_TEST','PRIVATE');
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status) SELECT 1000+i,108,'bulk-fixture-'||i||'.jpg','photo','READY' FROM generate_series(1,1007)i;`)
  const plan = validateIntent({
    where: { field: 'source_filename', op: 'contains', value: 'bulk-fixture-' },
    keywords: '',
    clarification: null,
  })
  intentMock.mockReset().mockResolvedValue({ intent: plan, metrics: { mode: 'sonnet' } })
  try {
    const ids: number[] = []
    let cursor: string | undefined
    do {
      const params = new URLSearchParams({
        q: 'Photos with filename containing bulk-fixture-',
        limit: '100',
      })
      if (cursor) params.set('cursor', cursor)
      const response = await photos(new Request('http://localhost/api/search?' + params))
      const body = await response.json()
      expect(response.status, JSON.stringify(body)).toBe(200)
      ids.push(...body.results.map((r: { photoId: number }) => r.photoId))
      cursor = body.nextCursor
      expect(ids.length).toBeLessThanOrEqual(1007)
    } while (cursor)
    expect(ids).toEqual(Array.from({ length: 1007 }, (_, i) => 2007 - i))
    expect(intentMock).toHaveBeenCalledTimes(1)
  } finally {
    await state.db!.exec(
      'DELETE FROM photos WHERE event_id=108;DELETE FROM events WHERE event_id=108',
    )
  }
}, 30000)

it('semantic and related toggles cannot relax typed requirements', async () => {
  state.live = false
  intentMock.mockImplementation(interpret)
  const item = acceptanceCases[4]
  const params = new URLSearchParams({ q: item.query, mode: 'semantic', related: 'true' })
  const response = await photos(new Request('http://localhost/api/search?' + params))
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(200)
  expect(
    body.results.map((r: { photoId: number }) => r.photoId).sort((a: number, b: number) => a - b),
  ).toEqual(item.expected)
})
