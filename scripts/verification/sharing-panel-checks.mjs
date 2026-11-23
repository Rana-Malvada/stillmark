import assert from 'node:assert/strict'

const waitFor = async (predicate) => {
  const until = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < until, 'Fixture request not received')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const sharing = (name) => ({
  owner: name.toUpperCase(),
  ownerDisplayName: name,
  visibility: 'PRIVATE',
  canEdit: true,
  mainAdmin: false,
  shares: [{ username: 'BOB', displayName: 'Bob Fixture' }],
})
const links = (name = 'Current album', status = 'active') => ({
  links: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      event_id: 101,
      event_name: name,
      owner_username: 'ALICE',
      created_by: 'ALICE',
      created_at: '2026-11-21T00:00:00Z',
      expires_at: '2026-12-21T00:00:00Z',
      allow_downloads: false,
      include_location: false,
      include_people: false,
      selected_count: null,
      status,
      canRevoke: true,
    },
  ],
  hasMore: false,
  owners: [],
  canFilterOwners: false,
})
export async function sharingPanelChecks({ scenario, origin, json, settled }) {
  await scenario(
    'Album sharing fences an earlier album response and clears denied members',
    async (page) => {
      let held
      let mode = 'valid'
      await page.route('**/api/events/*/sharing', (route) => {
        if (route.request().url().includes('/101/')) {
          held = route
          return
        }
        return mode === 'denied'
          ? route.fulfill({ status: 403, contentType: 'text/html', body: '<html>Denied</html>' })
          : json(route, mode === 'malformed' ? {} : sharing('New Owner Fixture'))
      })
      await page.goto(origin + '/fixture/sharing')
      await page.getByRole('button', { name: 'Album access', exact: true }).click()
      await waitFor(() => held)
      await page.getByRole('button', { name: 'Album B', exact: true }).click()
      await page.getByRole('button', { name: 'Album access', exact: true }).click()
      await page.getByText('Owner: New Owner Fixture', { exact: false }).waitFor()
      await json(held, sharing('Old Owner Fixture')).catch(() => {})
      await settled(page)
      assert.equal(await page.getByText('Owner: Old Owner Fixture', { exact: false }).count(), 0)
      await page.getByRole('button', { name: 'Close album access' }).click()
      mode = 'malformed'
      await page.getByRole('button', { name: 'Album access', exact: true }).click()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.getByText('Bob Fixture · Viewer').count(), 0)
      mode = 'valid'
      await page.getByRole('button', { name: 'Retry access' }).click()
      await page.getByText('Bob Fixture · Viewer').waitFor()
      mode = 'denied'
      await page.getByRole('button', { name: 'Close album access' }).click()
      await page.getByRole('button', { name: 'Album access', exact: true }).click()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.getByText('Bob Fixture · Viewer').count(), 0)
    },
  )
  await scenario(
    'Album sharing validates mutation acknowledgment and reconciles once',
    async (page) => {
      let shares = sharing('Owner Fixture')
      let writes = 0
      await page.route('**/api/events/*/sharing', (route) => {
        if (route.request().method() === 'POST') {
          writes++
          shares = { ...shares, shares: [] }
          return json(route, {})
        }
        return json(route, shares)
      })
      await page.goto(origin + '/fixture/sharing')
      await page.getByRole('button', { name: 'Album access', exact: true }).click()
      await page.getByRole('button', { name: 'Remove access' }).click()
      await page.getByRole('alert').waitFor()
      await settled(page)
      assert.equal(await page.getByText('Bob Fixture · Viewer').count(), 0)
      assert.equal(writes, 1, 'Uncertain sharing changes must not be automatically repeated')
    },
  )
  await scenario(
    'Shared links reject malformed pages, fence filters and clear forbidden rows',
    async (page) => {
      let mode = 'malformed'
      let held
      await page.route('**/api/shared-links?*', (route) => {
        if (mode === 'hold') {
          held = route
          mode = 'valid'
          return
        }
        if (mode === 'denied')
          return route.fulfill({
            status: 403,
            contentType: 'text/html',
            body: '<html>Denied</html>',
          })
        return json(route, mode === 'malformed' ? {} : links('Current album'))
      })
      await page.goto(origin + '/fixture/shared-links')
      await page.getByRole('alert').waitFor()
      mode = 'valid'
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByRole('link', { name: 'Current album', exact: true }).waitFor()
      mode = 'hold'
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await waitFor(() => held)
      await page.getByLabel('Status', { exact: true }).selectOption('expired')
      await page.getByRole('link', { name: 'Current album', exact: true }).waitFor()
      await json(held, links('Stale album')).catch(() => {})
      await settled(page)
      assert.equal(await page.getByRole('link', { name: 'Stale album', exact: true }).count(), 0)
      mode = 'denied'
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.getByRole('link', { name: 'Current album', exact: true }).count(), 0)
    },
  )
  await scenario(
    'Shared link revoke reconciles malformed success without repeating deletion',
    async (page) => {
      let state = 'active'
      let writes = 0
      await page.route('**/api/shared-links?*', (route) =>
        json(route, links('Current album', state)),
      )
      await page.route('**/api/events/101/links', (route) => {
        writes++
        state = 'revoked'
        return json(route, {})
      })
      page.on('dialog', (dialog) => dialog.accept())
      await page.goto(origin + '/fixture/shared-links')
      await page.getByRole('button', { name: 'Revoke', exact: true }).click()
      await page.getByRole('alert').waitFor()
      await page.getByText('Revoked ·', { exact: false }).waitFor()
      assert.equal(writes, 1)
      assert.equal(await page.getByRole('button', { name: 'Revoke', exact: true }).count(), 0)
    },
  )
  await scenario(
    'Public links reject malformed data, fence album changes and clear denied links',
    async (page) => {
      let held
      let mode = 'valid'
      const row = { ...links().links[0], revoked_at: null }
      await page.route('**/api/events/*/links', (route) => {
        if (route.request().url().includes('/101/')) {
          held = route
          return
        }
        if (mode === 'denied')
          return route.fulfill({ status: 403, contentType: 'text/html', body: 'Denied' })
        return json(route, mode === 'malformed' ? {} : [{ ...row, selected_count: 2 }])
      })
      await page.goto(origin + '/fixture/public-links')
      await page.getByRole('button', { name: 'Share whole album by link' }).click()
      await waitFor(() => held)
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByRole('button', { name: 'Album B', exact: true }).click()
      await page.getByRole('button', { name: 'Share whole album by link' }).click()
      await page.getByText('2 selected files ·', { exact: false }).waitFor()
      await json(held, [{ ...row, selected_count: 99 }]).catch(() => {})
      await settled(page)
      assert.equal(await page.getByText('99 selected files ·', { exact: false }).count(), 0)
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      mode = 'malformed'
      await page.getByRole('button', { name: 'Share whole album by link' }).click()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.getByRole('button', { name: 'Revoke', exact: true }).count(), 0)
      mode = 'valid'
      await page.getByRole('button', { name: 'Retry links' }).click()
      await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      mode = 'denied'
      await page.getByRole('button', { name: 'Share whole album by link' }).click()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.getByRole('button', { name: 'Revoke', exact: true }).count(), 0)
      assert.equal(
        await page.getByRole('button', { name: 'Create link', exact: true }).isDisabled(),
        true,
      )
    },
  )
  await scenario(
    'Public links reconcile uncertain create once and ignore a closed-dialog response',
    async (page) => {
      let state = []
      let writes = 0
      let held
      let hold = false
      const row = { ...links().links[0], revoked_at: null }
      await page.route('**/api/events/*/links', (route) => {
        if (route.request().method() === 'POST') {
          writes++
          state = [row]
          if (hold) {
            held = route
            return
          }
          return json(route, {})
        }
        return json(route, state)
      })
      await page.goto(origin + '/fixture/public-links')
      await page.getByRole('button', { name: 'Share whole album by link' }).click()
      await page.getByRole('button', { name: 'Create link', exact: true }).click()
      await page.getByRole('alert').waitFor()
      await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor()
      assert.equal(writes, 1)
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      hold = true
      await page.getByRole('button', { name: 'Share whole album by link' }).click()
      await page.getByRole('button', { name: 'Create link', exact: true }).click()
      await waitFor(() => held)
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByRole('button', { name: 'Share whole album by link' }).click()
      await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor()
      await json(held, {
        id: row.id,
        path: '/share/' + 'a'.repeat(43),
        expiresAt: row.expires_at,
      }).catch(() => {})
      await settled(page)
      assert.equal(await page.getByRole('button', { name: 'Copy link', exact: true }).count(), 0)
      assert.equal(
        await page.getByRole('button', { name: 'Create link', exact: true }).isDisabled(),
        false,
      )
      // A parent capability refresh unmounts an open editor immediately.
      await page
        .getByRole('button', { name: 'Revoke editing', exact: true })
        .evaluate((button) => button.click())
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Share whole album by link' }).count(), 0)
    },
  )
}
