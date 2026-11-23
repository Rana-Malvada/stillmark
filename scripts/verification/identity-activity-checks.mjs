import assert from 'node:assert/strict'

const waitFor = async (predicate) => {
  const end = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < end, 'Expected request')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const summary = (name) => ({
  rows: [
    {
      day: '2026-11-21',
      kind: 'login',
      provider: 'auth0',
      events: 1,
      successes: 1,
      failures: 0,
      displayName: name,
      email: null,
    },
  ],
  more: false,
})
export async function identityActivityChecks({ scenario, origin, json, settled }) {
  await scenario(
    'Identity activity malformed status is recoverable and never crashes find',
    async (page) => {
      let malformed = true
      await page.route('**/api/user-activity/identity', (r) => json(r, malformed ? {} : []))
      await page.goto(origin + '/fixture/identity')
      await page.getByRole('alert').filter({ hasText: 'Unable to load import status' }).waitFor()
      malformed = false
      await page.reload()
      await settled(page)
      await page.getByRole('button', { name: 'Import Auth0 logs', exact: true }).waitFor()
      assert.equal(await page.getByRole('alert').count(), 0)
    },
  )
  await scenario(
    'Identity activity summary follows current filters and clears denied data',
    async (page) => {
      let held
      let denied = false
      await page.route('**/api/user-activity/identity', (r) => json(r, []))
      await page.route('**/api/user-activity/summary?*', (r) => {
        if (new URL(r.request().url()).searchParams.get('user') === 'ALICE') {
          held = r
          return
        }
        return denied ? json(r, { error: 'Access denied' }, 403) : json(r, summary('Bob report'))
      })
      await page.goto(origin + '/fixture/identity')
      await page.getByRole('button', { name: 'Show retained daily totals', exact: true }).click()
      await waitFor(() => held)
      await page.getByRole('button', { name: 'Change report user', exact: true }).click()
      await page.getByRole('button', { name: 'Show retained daily totals', exact: true }).click()
      await page
        .locator('td')
        .filter({ hasText: /^Bob report$/ })
        .waitFor({ state: 'attached' })
      await json(held, summary('Alice old report')).catch(() => {})
      await settled(page)
      assert.equal(await page.getByText('Alice old report', { exact: true }).count(), 0)
      denied = true
      await page.getByRole('button', { name: 'Show retained daily totals', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: 'Access denied' }).waitFor()
      assert.equal(
        await page
          .locator('td')
          .filter({ hasText: /^Bob report$/ })
          .count(),
        0,
      )
    },
  )
  await scenario(
    'Identity activity accepted import survives failed status refresh without reposting',
    async (page) => {
      let imported = false
      let posts = 0
      await page.route('**/api/user-activity/identity', (r) => {
        if (r.request().method() === 'POST') {
          posts++
          imported = true
          return json(r, { imported: 3, more: false })
        }
        return json(r, imported ? {} : [])
      })
      await page.goto(origin + '/fixture/identity')
      await page.getByRole('button', { name: 'Import Auth0 logs', exact: true }).click()
      await page.getByRole('status').filter({ hasText: 'Imported 3 new events' }).waitFor()
      await page
        .getByRole('alert')
        .filter({ hasText: 'Import completed, but its status could not be refreshed' })
        .waitFor()
      assert.equal(posts, 1)
    },
  )
}
