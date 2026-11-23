import assert from 'node:assert/strict'

const id = '11111111-1111-4111-8111-111111111111'
const choice = (index) => ({
  personId: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
  name: `Person ${String(index).padStart(3, '0')}`,
  coverFaceId: null,
  photoCount: 2,
})
const waitFor = async (predicate) => {
  const until = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < until, 'Timed out waiting for people options')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const detail = {
  person: {
    personId: id,
    name: 'Alice',
    hidden: false,
    coverFaceId: null,
    photoCount: 1,
    reviewCount: 0,
  },
  faces: [{ faceId: 1, photoId: 1, hasCrop: false, status: 'confirmed' }],
  more: false,
  nextCursor: null,
}
export async function peoplePickerChecks({ scenario, origin, json, settled }) {
  for (const width of [390, 1280])
    await scenario(
      `People picker lazy paged merge does not move faces at ${width}px`,
      async (page) => {
        await page.setViewportSize({ width, height: 844 })
        const requests = []
        let fullPrefetch = 0
        await page.route('**/api/people?*', (r) => {
          fullPrefetch++
          return json(r, { people: [] })
        })
        await page.route('**/api/people/' + id, (r) => json(r, detail))
        await page.route('**/api/people/options?*', (r) => {
          const query = new URL(r.request().url()).searchParams
          requests.push(Object.fromEntries(query))
          assert.equal(query.get('details'), 'true')
          return json(r, {
            people: Array.from({ length: 50 }, (_, i) =>
              choice((query.has('cursor') ? 50 : 0) + i),
            ),
            nextCursor: query.has('cursor') ? null : 'next-page',
          })
        })
        await page.goto(origin + '/people/' + id)
        await page.locator('[data-selection-id="1"]').waitFor()
        await page.locator('style').evaluateAll((nodes) => nodes.forEach((n) => n.remove()))
        await page.addStyleTag({ url: origin + '/layout.css' })
        await settled(page)
        await page.waitForTimeout(250)
        assert.equal(requests.length, 0)
        assert.equal(fullPrefetch, 0)
        const before = await page.locator('[data-selection-id="1"]').boundingBox()
        await page.getByRole('button', { name: 'Person actions', exact: true }).click()
        await page.getByRole('button', { name: 'Merge with another person', exact: true }).click()
        await page.getByRole('button', { name: 'Load more names', exact: true }).waitFor()
        const picker = page.getByRole('region', { name: 'Merge with someone', exact: true })
        assert.equal(await picker.locator('li').count(), 50)
        await page.getByRole('button', { name: 'Load more names', exact: true }).click()
        await waitFor(() => requests.length === 2)
        await page.waitForFunction(
          () => document.querySelectorAll('[aria-label="Merge with someone"] li').length === 100,
        )
        assert.equal(requests[1].cursor, 'next-page')
        const after = await page.locator('[data-selection-id="1"]').boundingBox()
        assert.ok(
          Math.abs(after.y - before.y) < 1,
          'Opening/loading merge choices must not shift faces',
        )
        assert.equal(fullPrefetch, 0)
      },
    )
  await scenario(
    'People picker ignored face is lazy and preserves an off-page selected person',
    async (page) => {
      const requests = []
      const writes = []
      await page.route('**/api/people/options?*', (r) => {
        const query = new URL(r.request().url()).searchParams
        requests.push(Object.fromEntries(query))
        return json(r, {
          people:
            query.get('q') === 'Remote'
              ? [{ ...choice(99), name: 'Remote existing person' }]
              : Array.from({ length: 50 }, (_, i) => choice(i)),
          nextCursor: query.get('q') ? null : 'next-page',
        })
      })
      await page.route('**/api/people/assign', (r) => {
        writes.push(r.request().postDataJSON())
        return json(r, { ok: true })
      })
      await page.goto(origin + '/fixture/ignored-face')
      await page.getByRole('dialog', { name: 'Ignored face', exact: true }).waitFor()
      await page.waitForTimeout(250)
      assert.equal(requests.length, 0)
      const trigger = page.getByRole('button', {
        name: 'Assign and restore: choose a person',
        exact: true,
      })
      await trigger.click()
      await page.getByRole('button', { name: 'Person 000', exact: true }).waitFor()
      assert.equal(await page.locator('[aria-label="Matching people"] button').count(), 50)
      await page.getByRole('textbox', { name: 'Search people', exact: true }).fill('Remote')
      await page.getByRole('button', { name: 'Remote existing person', exact: true }).click()
      assert.match(await trigger.innerText(), /Remote existing person/)
      await trigger.click()
      await page.getByRole('button', { name: 'Person 000', exact: true }).waitFor()
      await page.getByRole('textbox', { name: 'Search people', exact: true }).press('Escape')
      assert.match(
        await trigger.innerText(),
        /Remote existing person/,
        'Selection label survives loading another page',
      )
      await page.getByRole('button', { name: 'Assign and restore', exact: true }).click()
      await page.getByText('Saved face', { exact: true }).waitFor()
      assert.deepEqual(writes, [{ faceIds: [1], personId: choice(99).personId }])
    },
  )
  await scenario(
    'People picker ignores stale queries and offers retry after a read failure',
    async (page) => {
      let old
      let fail = true
      await page.route('**/api/people/options?*', (r) => {
        const query = new URL(r.request().url()).searchParams.get('q')
        if (query === 'Old') {
          old = r
          return
        }
        if (query === 'New' && fail)
          return r.fulfill({
            status: 502,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Temporary name lookup failure' }),
          })
        return json(r, {
          people: query === 'New' ? [{ ...choice(2), name: 'New name' }] : [choice(0)],
          nextCursor: null,
        })
      })
      await page.goto(origin + '/fixture/ignored-face')
      await page
        .getByRole('button', { name: 'Assign and restore: choose a person', exact: true })
        .click()
      const search = page.getByRole('textbox', { name: 'Search people', exact: true })
      await search.fill('Old')
      await waitFor(() => old)
      await search.fill('New')
      await page.getByRole('button', { name: 'Retry', exact: true }).waitFor()
      fail = false
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
      await page.getByRole('button', { name: 'New name', exact: true }).waitFor()
      await json(old, { people: [{ ...choice(1), name: 'Old name' }], nextCursor: null }).catch(
        () => {},
      )
      await settled(page)
      assert.equal(await page.getByRole('button', { name: 'Old name', exact: true }).count(), 0)
      assert.equal(await page.getByRole('alert').count(), 0)
    },
  )
  await scenario(
    'People picker typed off-page existing name goes to server identity resolution',
    async (page) => {
      const writes = []
      await page.route('**/api/people/options?*', (r) =>
        json(r, { people: [choice(0)], nextCursor: 'more' }),
      )
      await page.route('**/api/people/assign', (r) => {
        writes.push(r.request().postDataJSON())
        return json(r, { ok: true })
      })
      await page.goto(origin + '/fixture/ignored-face')
      await page
        .getByRole('button', { name: 'Assign and restore: choose a person', exact: true })
        .click()
      await page.getByRole('button', { name: '+ Add a new person', exact: true }).click()
      await page
        .getByRole('textbox', { name: 'New person’s name', exact: true })
        .fill('Off-page existing name')
      await page.getByRole('button', { name: 'Assign and restore', exact: true }).click()
      await page.getByText('Saved face', { exact: true }).waitFor()
      assert.deepEqual(writes, [{ faceIds: [1], name: 'Off-page existing name' }])
    },
  )
  for (const fault of ['malformed', 'revoked']) {
    await scenario(
      `People picker ${fault} later page has safe retry and permission handling`,
      async (page) => {
        const cursors = []
        let fail = true
        await page.route('**/api/people/options?*', (route) => {
          const cursor = new URL(route.request().url()).searchParams.get('cursor')
          cursors.push(cursor)
          if (cursor && fail)
            return fault === 'revoked'
              ? route.fulfill({
                  status: 403,
                  contentType: 'application/json',
                  body: JSON.stringify({ error: 'Access removed' }),
                })
              : json(route, { people: {}, nextCursor: null })
          return json(route, {
            people: [choice(cursor ? 50 : 0)],
            nextCursor: cursor ? null : 'second-page',
          })
        })
        await page.goto(origin + '/fixture/ignored-face')
        await page
          .getByRole('button', { name: 'Assign and restore: choose a person', exact: true })
          .click()
        await page.getByRole('button', { name: 'Person 000', exact: true }).waitFor()
        await page.getByRole('button', { name: 'Load more names', exact: true }).click()
        await page.getByRole('button', { name: 'Retry', exact: true }).waitFor()
        assert.equal(
          await page.getByRole('button', { name: 'Person 000', exact: true }).count(),
          fault === 'revoked' ? 0 : 1,
        )
        fail = false
        await page.getByRole('button', { name: 'Retry', exact: true }).click()
        await page
          .getByRole('button', {
            name: fault === 'revoked' ? 'Person 000' : 'Person 050',
            exact: true,
          })
          .waitFor()
        assert.deepEqual(cursors, [null, 'second-page', fault === 'revoked' ? null : 'second-page'])
        assert.equal(await page.getByRole('alert').count(), 0)
      },
    )
  }
}
