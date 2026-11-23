import assert from 'node:assert/strict'

const account = {
  displayName: 'Alice',
  email: 'alice@example.test',
  publicAccount: true,
  uploadLimit: 100,
  uploadsUsed: 2,
}
const auth = {
  authenticated: true,
  username: 'ALICE',
  displayName: 'Alice',
  role: 'viewer',
  mainAdmin: false,
  canManageAccess: false,
  canManagePersonal: true,
}
async function shortDeadlines(page) {
  await page.addInitScript(() => {
    const original = window.setTimeout
    window.setTimeout = (fn, ms, ...args) =>
      original(fn, [15_000, 45_000, 600_000].includes(ms) ? 120 : ms, ...args)
  })
}
export async function clientBoundaryRecoveryChecks({ scenario, origin, json, settled }) {
  await scenario('Client boundaries: account malformed load has direct retry', async (page) => {
    let valid = false
    await page.route('**/api/account', (route) =>
      json(route, valid ? account : { displayName: [] }),
    )
    await page.goto(origin + '/fixture/account')
    await page.getByRole('button', { name: 'Try again', exact: true }).waitFor()
    valid = true
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await page.getByRole('textbox', { name: 'Display name' }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: 'Display name' }).inputValue(), 'Alice')
  })
  for (const mode of ['headers', 'body'])
    await scenario('Client boundaries: account ' + mode + ' timeout allows retry', async (page) => {
      await shortDeadlines(page)
      await page.addInitScript((mode) => {
        const original = window.fetch
        window.fixtureStall = true
        window.fetch = (url, init) =>
          url === '/api/account' && window.fixtureStall
            ? mode === 'headers'
              ? new Promise(() => {})
              : Promise.resolve(
                  new Response(new ReadableStream({ start() {} }), {
                    headers: { 'Content-Type': 'application/json' },
                  }),
                )
            : original(url, init)
      }, mode)
      await page.route('**/api/account', (route) => json(route, account))
      await page.goto(origin + '/fixture/account')
      await page.getByRole('button', { name: 'Try again', exact: true }).waitFor()
      await page.evaluate(() => (window.fixtureStall = false))
      await page.getByRole('button', { name: 'Try again', exact: true }).click()
      await page.getByRole('textbox', { name: 'Display name' }).waitFor()
    })
  await scenario(
    'Client boundaries: uncertain profile save reads actual outcome without replay',
    async (page) => {
      let saved = account
      let posts = 0
      await page.route('**/api/auth/me', (route) =>
        json(route, { ...auth, displayName: saved.displayName }),
      )
      await page.route('**/api/account', (route) => {
        if (route.request().method() === 'GET') return json(route, saved)
        posts++
        saved = { ...account, displayName: route.request().postDataJSON().displayName }
        return route.abort('connectionfailed')
      })
      await page.goto(origin + '/fixture/account')
      await page.getByRole('textbox', { name: 'Display name' }).fill('Updated')
      await page.getByRole('button', { name: 'Save profile', exact: true }).click()
      await page.getByRole('status').filter({ hasText: 'result could not be confirmed' }).waitFor()
      assert.equal(posts, 1)
      assert.equal(
        await page.getByRole('textbox', { name: 'Display name' }).inputValue(),
        'Updated',
      )
      assert.equal(
        await page.getByRole('button', { name: 'Save profile', exact: true }).isEnabled(),
        true,
      )
    },
  )
  for (const mode of ['headers', 'body'])
    await scenario(
      'Client boundaries: profile save ' + mode + ' stall reconciles and releases busy',
      async (page) => {
        await shortDeadlines(page)
        await page.addInitScript((mode) => {
          const original = window.fetch
          window.fetch = async (url, init) => {
            const response = await original(url, init)
            if (url === '/api/account' && init?.method === 'PATCH')
              return mode === 'headers'
                ? new Promise(() => {})
                : new Response(new ReadableStream({ start() {} }), {
                    headers: { 'Content-Type': 'application/json' },
                  })
            return response
          }
        }, mode)
        let saved = account
        let writes = 0
        await page.route('**/api/auth/me', (route) => json(route, auth))
        await page.route('**/api/account', (route) => {
          if (route.request().method() === 'GET') return json(route, saved)
          writes++
          saved = { ...account, displayName: 'Recovered' }
          return json(route, { ok: true })
        })
        await page.goto(origin + '/fixture/account')
        await page.getByRole('textbox', { name: 'Display name' }).fill('Recovered')
        await page.getByRole('button', { name: 'Save profile', exact: true }).click()
        await page
          .getByRole('status')
          .filter({ hasText: 'result could not be confirmed' })
          .waitFor()
        assert.equal(writes, 1)
        assert.equal(
          await page.getByRole('textbox', { name: 'Display name' }).inputValue(),
          'Recovered',
        )
        assert.equal(
          await page.getByRole('button', { name: 'Save profile', exact: true }).isEnabled(),
          true,
        )
      },
    )
  await scenario(
    'Client boundaries: uncertain account deletion is never replayed and clears revoked authority',
    async (page) => {
      let deleted = false
      let writes = 0
      page.on('dialog', (dialog) => void dialog.accept('DELETE'))
      await page.route('**/api/auth/me', (route) => json(route, { error: 'Account disabled' }, 403))
      await page.route('**/api/account', (route) => {
        if (route.request().method() === 'GET')
          return json(route, deleted ? { error: 'Account disabled' } : account, deleted ? 403 : 200)
        assert.equal(route.request().method(), 'DELETE')
        deleted = true
        writes++
        return route.abort('connectionfailed')
      })
      await page.goto(origin + '/fixture/account')
      await page.getByRole('button', { name: 'Request account deletion', exact: true }).click()
      await page.getByRole('status').filter({ hasText: 'result could not be confirmed' }).waitFor()
      assert.equal(writes, 1)
      assert.equal(await page.getByRole('textbox', { name: 'Display name' }).count(), 0)
      assert.equal(await page.getByText('Identity: signed out', { exact: true }).count(), 1)
      assert.equal(new URL(page.url()).pathname, '/fixture/account')
    },
  )
  await scenario(
    'Client boundaries: navigation during profile save ignores late completion',
    async (page) => {
      let held
      await page.route('**/api/account', (route) =>
        route.request().method() === 'GET' ? json(route, account) : (held = route),
      )
      await page.goto(origin + '/fixture/account')
      await page.getByRole('textbox', { name: 'Display name' }).fill('Updated')
      await page.getByRole('button', { name: 'Save profile', exact: true }).click()
      await page.getByRole('button', { name: 'Leave account', exact: true }).click()
      await json(held, { ok: true })
      await settled(page)
      assert.equal(await page.getByText('Profile saved.', { exact: true }).count(), 0)
      assert.equal(await page.getByText('Account closed', { exact: true }).count(), 1)
    },
  )
  for (const mode of ['headers', 'body'])
    await scenario(
      'Client boundaries: logout ' + mode + ' timeout retains identity and permits retry',
      async (page) => {
        await shortDeadlines(page)
        await page.addInitScript((mode) => {
          const original = window.fetch
          window.fixtureStall = true
          window.fetch = (url, init) =>
            url === '/api/auth/logout-url' && window.fixtureStall
              ? mode === 'headers'
                ? new Promise(() => {})
                : Promise.resolve(
                    new Response(new ReadableStream({ start() {} }), {
                      headers: { 'Content-Type': 'application/json' },
                    }),
                  )
              : original(url, init)
          window.galleryLogouts = 0
          window.addEventListener('gallery-logout', () => window.galleryLogouts++)
        }, mode)
        let revoked = 0
        await page.route('**/api/auth/logout-url', (route) =>
          json(route, { url: 'https://login.example.test/logout' }),
        )
        await page.route('**/sfc-endpoint/logout', (route) => {
          revoked++
          return json(route, { responseType: 'SUCCESS_RESPOND_TO_CUSTOMER' })
        })
        await page.goto(origin + '/fixture/auth')
        await page.getByRole('button', { name: 'Sign out', exact: true }).click()
        await page.getByRole('alert').filter({ hasText: 'timed out' }).waitFor()
        assert.equal(revoked, 0)
        assert.equal(await page.evaluate(() => window.galleryLogouts), 0)
        assert.equal(
          await page.getByRole('button', { name: 'Sign out', exact: true }).isEnabled(),
          true,
        )
        await page.evaluate(() => (window.fixtureStall = false))
        await page.getByRole('button', { name: 'Sign out', exact: true }).click()
        await page.waitForURL('https://login.example.test/logout').catch(() => {})
        assert.equal(revoked, 1)
      },
    )
  await scenario(
    'Client boundaries: invalid auth refresh preserves identity; denied refresh clears it',
    async (page) => {
      let denied = false
      await page.route('**/api/auth/me', (route) =>
        json(
          route,
          denied ? { error: 'Session ended' } : { ...auth, role: 'superuser' },
          denied ? 401 : 200,
        ),
      )
      await page.goto(origin + '/fixture/auth')
      await page.getByRole('button', { name: 'Refresh identity', exact: true }).click()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.getByText('Identity: ALICE', { exact: true }).count(), 1)
      denied = true
      await page.getByRole('button', { name: 'Refresh identity', exact: true }).click()
      await page.getByText('Identity: signed out', { exact: true }).waitFor()
    },
  )
  for (const initial of [true, false])
    await scenario(
      'Client boundaries: slideshow ' +
        (initial ? 'initial' : 'continuation') +
        ' failure retries the cursor in place',
      async (page) => {
        let fail = true
        const cursors = []
        const media = (n) => ({
          photoId: n,
          sourceFilename: 'Photo ' + n,
          mediaType: 'photo',
          displayStagePath: null,
          originalStagePath: null,
        })
        await page.route('**/api/events/7?*', (route) => {
          const cursor = new URL(route.request().url()).searchParams.get('cursor')
          cursors.push(cursor)
          if (fail && (initial || cursor)) return json(route, { items: null }, 503)
          return json(route, {
            items: cursor ? [media(1), media(2), media(2)] : [media(1)],
            nextCursor: cursor || initial ? null : 'next',
          })
        })
        await page.goto(origin + '/fixture/slideshow/7')
        await page.getByRole('button', { name: 'Retry loading photos', exact: true }).waitFor()
        if (!initial) assert.equal(await page.getByText('Photo 1', { exact: true }).count(), 1)
        fail = false
        await page.getByRole('button', { name: 'Retry loading photos', exact: true }).click()
        await page.getByText('Photo 1', { exact: true }).waitFor()
        if (!initial) {
          await page.waitForFunction(
            () => document.querySelector('.viewer-toolbar span')?.textContent.trim() === '1 / 2',
          )
          await page.getByRole('button', { name: 'Next', exact: true }).click()
          await page.getByText('Photo 2', { exact: true }).waitFor()
          assert.deepEqual(cursors.filter(Boolean), ['next', 'next'])
        }
      },
    )
  await scenario(
    'Client boundaries: stalled original preparation releases retry and keeps fresh-tap sharing',
    async (page) => {
      await shortDeadlines(page)
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'userAgent', { get: () => 'iPhone' })
        Object.defineProperty(navigator, 'userActivation', { get: () => ({ isActive: false }) })
        navigator.canShare = () => true
        navigator.share = async ({ files }) => {
          window.sharedOriginal = await files[0].text()
        }
        const original = window.fetch
        window.fixtureStall = true
        window.fetch = (url, init) =>
          String(url).startsWith('/original') && window.fixtureStall
            ? Promise.resolve(
                new Response(new ReadableStream({ start() {} }), {
                  headers: { 'Content-Type': 'video/mp4' },
                }),
              )
            : original(url, init)
      })
      await page.route('**/original?*', (route) =>
        route.fulfill({ contentType: 'video/mp4', body: 'original bytes' }),
      )
      await page.goto(origin + '/fixture/save-original')
      await page.getByRole('button', { name: 'Save video', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: 'timed out' }).waitFor()
      await page.evaluate(() => (window.fixtureStall = false))
      await page.getByRole('button', { name: 'Try again', exact: true }).click()
      await page.getByRole('button', { name: 'Save or share', exact: true }).click()
      await page.waitForFunction(() => window.sharedOriginal === 'original bytes')
      assert.equal(await page.evaluate(() => window.sharedOriginal), 'original bytes')
    },
  )
}
