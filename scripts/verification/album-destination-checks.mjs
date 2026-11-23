import assert from 'node:assert/strict'

export async function albumDestinationChecks({ scenario, origin, json, settled }) {
  await scenario(
    'Album destinations: retry cursor, duplicate pages and revoked selection',
    async (page) => {
      let fail = true
      const cursors = []
      await page.route('**/api/events?*', (route) => {
        const cursor = new URL(route.request().url()).searchParams.get('cursor')
        cursors.push(cursor)
        if (cursor && fail) return json(route, { error: 'Temporary failure' }, 503)
        return json(
          route,
          cursor
            ? {
                items: [
                  { eventId: 1, eventName: 'Trip 10', canEdit: false },
                  { eventId: 2, eventName: 'Trip 2', canEdit: true },
                  { eventId: 3, eventName: 'Trip 1', canEdit: true },
                ],
                nextCursor: null,
              }
            : {
                items: [
                  { eventId: 1, eventName: 'Trip 10', canEdit: true },
                  { eventId: 2, eventName: 'Trip 2', canEdit: true },
                ],
                nextCursor: 'second',
              },
        )
      })
      await page.goto(origin + '/fixture/destinations')
      await page.getByRole('button', { name: 'Load destinations', exact: true }).click()
      await page
        .getByRole('option', { name: 'Trip 10', exact: true })
        .waitFor({ state: 'attached' })
      await page.getByLabel('Destination', { exact: true }).selectOption('1')
      await page.getByRole('button', { name: 'Next destinations', exact: true }).click()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.getByLabel('Destination', { exact: true }).inputValue(), '1')
      fail = false
      await page.getByRole('button', { name: 'Retry destinations', exact: true }).click()
      await page.getByRole('option', { name: 'Trip 1', exact: true }).waitFor({ state: 'attached' })
      assert.deepEqual(cursors, [null, 'second', 'second'])
      assert.deepEqual(
        await page.getByLabel('Destination', { exact: true }).locator('option').allTextContents(),
        ['Choose', 'Trip 1', 'Trip 2'],
      )
      assert.equal(await page.getByLabel('Destination', { exact: true }).inputValue(), '')
    },
  )
  await scenario('Album destinations: scope reset rejects stale responses', async (page) => {
    let held
    await page.route('**/api/events?*', (route) => {
      held = route
    })
    await page.goto(origin + '/fixture/destinations')
    await page.getByRole('button', { name: 'Load destinations', exact: true }).click()
    await page.getByText('Loading destinations', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Change destination scope', exact: true }).click()
    await json(held, {
      items: [{ eventId: 1, eventName: 'Stale', canEdit: true }],
      nextCursor: 'old',
    }).catch(() => {})
    await settled(page)
    assert.equal(await page.getByRole('option', { name: 'Stale', exact: true }).count(), 0)
    assert.equal(
      await page.getByRole('button', { name: 'Next destinations', exact: true }).isDisabled(),
      true,
    )
    await page.unroute('**/api/events?*')
    await page.route('**/api/events?*', (route) =>
      json(route, {
        items: [{ eventId: 2, eventName: 'Current', canEdit: true }],
        nextCursor: null,
      }),
    )
    await page.getByRole('button', { name: 'Load destinations', exact: true }).click()
    await page.getByRole('option', { name: 'Current', exact: true }).waitFor({ state: 'attached' })
  })
}
