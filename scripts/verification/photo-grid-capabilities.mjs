import assert from 'node:assert/strict'

const photo = (id, canEdit) => ({
  photoId: id,
  eventId: 7 + id,
  sourceFilename: `Favorite ${id}`,
  thumbnailUrl: null,
  aspectRatio: 1,
  mediaType: 'photo',
  favorite: true,
  canEdit,
})

/** Actual PhotoGrid with synthetic faults and ordinary-owner identities. */
export async function photoGridCapabilityChecks({ scenario, origin, json, settled }) {
  async function style(page) {
    await page.locator('style').evaluateAll((styles) => styles.forEach((s) => s.remove()))
    await page.addStyleTag({ url: origin + '/layout.css' })
    await settled(page)
  }
  const actions = (page) => page.getByRole('button', { name: 'Actions', exact: true }).click()
  const move = (page) =>
    page
      .locator('summary')
      .filter({ hasText: /^Move to album$/ })
      .click()

  for (const failure of ['unavailable', 'malformed']) {
    await scenario(
      `Destination ${failure} preserves photos, selection and other actions`,
      async (page) => {
        let requests = 0
        let recover = false
        let mutations = 0
        await page.route('**/api/events/7?*', (route) =>
          json(route, {
            items: [1, 2].map((id) => ({ ...photo(id, true), eventId: 7 })),
            nextCursor: null,
          }),
        )
        await page.route('**/api/events?*', (route) => {
          requests++
          return recover
            ? json(route, {
                items: [{ eventId: 8, eventName: 'Destination', canEdit: true }],
                nextCursor: null,
              })
            : failure === 'unavailable'
              ? json(route, { error: 'Unable to load destination albums' }, 503)
              : json(route, { items: [{ eventId: 8, eventName: 'Malformed' }], nextCursor: null })
        })
        await page.route('**/api/photos/bulk', (route) => {
          mutations++
          assert.deepEqual(route.request().postDataJSON().ids, [1])
          return json(route, { count: 1 })
        })
        await page.goto(origin + '/events/7')
        await style(page)
        const tiles = page.locator('.photo-tile')
        await tiles.first().waitFor()
        const before = await tiles.first().boundingBox()
        await page.getByRole('button', { name: 'Select photos', exact: true }).click()
        await tiles.first().click()
        await actions(page)
        assert.equal(requests, 0, 'Selection and its commands must not fetch Move destinations')
        await move(page)
        await page.getByRole('button', { name: 'Retry albums' }).waitFor()
        assert.equal(await tiles.count(), 2)
        assert.equal(await tiles.first().locator('button').getAttribute('aria-pressed'), 'true')
        assert.deepEqual(
          await tiles.first().boundingBox(),
          before,
          'Ancillary failure must not move the grid',
        )
        assert.equal(
          await page.getByRole('button', { name: 'Favorite', exact: true }).isEnabled(),
          true,
        )
        assert.equal(
          await page.getByRole('link', { name: 'Download ZIP' }).getAttribute('href'),
          '/api/photos/download?ids=1',
        )
        recover = true
        await page.getByRole('button', { name: 'Retry albums' }).click()
        await page
          .getByRole('option', { name: 'Destination', exact: true })
          .waitFor({ state: 'attached' })
        assert.equal(await page.getByRole('button', { name: 'Retry albums' }).count(), 0)
        assert.equal(requests, 2)
        await move(page)
        await page.getByRole('button', { name: 'Favorite', exact: true }).click()
        await page.getByText('1 files updated', { exact: false }).waitFor()
        assert.equal(mutations, 1)
      },
    )
  }

  await scenario(
    'Closing selection cancels destination lookup without removing photos',
    async (page) => {
      let release
      await page.route('**/api/events/7?*', (route) =>
        json(route, {
          items: [{ ...photo(1, true), eventId: 7 }],
          nextCursor: null,
        }),
      )
      await page.route('**/api/events?*', async (route) => {
        await new Promise((resolve) => {
          release = resolve
        })
        await json(route, { items: null, nextCursor: null }).catch(() => {})
      })
      await page.goto(origin + '/events/7')
      await style(page)
      await page.locator('.photo-tile').waitFor()
      await page.getByRole('button', { name: 'Select photos', exact: true }).click()
      await page.locator('.photo-tile').click()
      await actions(page)
      await move(page)
      await page.getByRole('status').filter({ hasText: 'Loading albums' }).waitFor()
      await page.getByRole('button', { name: 'Done selecting', exact: true }).click()
      release?.()
      await settled(page)
      assert.equal(await page.locator('.photo-tile').count(), 1)
      assert.equal(await page.getByRole('alert').count(), 0)
    },
  )

  for (const identity of [
    { name: 'ordinary owner', role: 'viewer', own: true, other: false },
    { name: 'shared reader', role: 'viewer', own: false, other: false },
    { name: 'ordinary administrator', role: 'admin', own: true, other: false },
    { name: 'main administrator', role: 'admin', main: true, own: true, other: true },
    { name: 'read-only administrator', role: 'admin_readonly', own: false, other: false },
    {
      name: 'disabled personal management',
      role: 'viewer',
      disabled: true,
      own: false,
      other: false,
    },
  ]) {
    await scenario(`Favorites selection respects ${identity.name} capabilities`, async (page) => {
      let mutations = 0
      await page.route('**/api/favorites?*', (route) =>
        json(route, {
          items: [photo(1, identity.own), photo(2, identity.other)],
          nextCursor: null,
        }),
      )
      await page.route('**/api/photos/bulk', (route) => {
        mutations++
        return json(route, { count: 1 })
      })
      const query = new URLSearchParams({
        fixtureRole: identity.role,
        fixtureMainAdmin: String(!!identity.main),
        fixtureCanManage: String(!identity.disabled),
      })
      await page.goto(origin + '/favorites?' + query)
      await style(page)
      const tiles = page.locator('.photo-tile')
      await tiles.first().waitFor()
      await page.getByRole('button', { name: 'Select photos', exact: true }).click()
      await tiles.first().click()
      await actions(page)
      assert.equal(
        await page.getByRole('button', { name: 'Unfavorite', exact: true }).isEnabled(),
        identity.own,
      )
      await actions(page)
      await tiles.nth(1).click()
      await actions(page)
      assert.equal(
        await page.getByRole('button', { name: 'Unfavorite', exact: true }).isEnabled(),
        identity.own && identity.other,
      )
      assert.equal(
        await page.getByRole('link', { name: 'Download ZIP' }).getAttribute('href'),
        '/api/photos/download?ids=1,2',
      )
      assert.equal(mutations, 0, 'A mixed/read-only selection must not issue a write')
      if (identity.own) {
        await actions(page)
        await tiles.nth(1).click()
        await actions(page)
        await page.getByRole('button', { name: 'Unfavorite', exact: true }).click()
        await page.getByText('1 files updated', { exact: false }).waitFor()
        assert.equal(mutations, 1)
      }
    })
  }
}
