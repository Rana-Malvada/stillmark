import assert from 'node:assert/strict'

const waitFor = async (predicate) => {
  const until = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < until, 'Fixture request not received')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function saveAllowance(page) {
  const form = page.getByRole('form', { name: 'Upload allowance', exact: true })
  await form.getByLabel('Total files', { exact: true }).fill('10')
  await form.getByLabel('Total storage (GiB)', { exact: true }).fill('10')
  await form.getByLabel('AI searches per day', { exact: true }).fill('10')
  await form.getByRole('button', { name: 'Save allowance', exact: true }).click()
}
const overview = (enabled) => ({
  auth0Enabled: false,
  customerAccountsEnabled: false,
  permissionAuthority: 'postgres',
  users: [
    {
      name: 'JANE',
      marker: '11111111-1111-4111-8111-111111111111',
      display_name: 'Jane Fixture',
      email: 'jane@example.invalid',
      state: 'ready',
      enabled,
      roles: ['MEMBER'],
      issue: null,
    },
  ],
  roles: [{ name: 'MEMBER', display_name: 'Member', profile: 'viewer', state: 'ready' }],
  operations: [],
  refreshedAt: '2026-11-22T00:00:00Z',
})
export async function accessPanelChecks({ scenario, origin, json, settled }) {
  await scenario(
    'Access allowance rejects malformed responses and recovers without duplicate writes',
    async (page) => {
      let posts = 0
      let held
      let valid = false
      const data = overview(true)
      data.users[0].registration_source = 'public'
      await page.route('**/api/admin/access', (route) => json(route, data))
      await page.route('**/api/admin/customer-allowance', (route) => {
        posts++
        if (!valid) {
          held = route
          return
        }
        return json(route, { ok: true })
      })
      await page.goto(origin + '/fixture/access')
      const action = page.getByRole('button', { name: 'Set upload allowance', exact: true })
      // The allowance is an inline form: nothing is sent until it is saved.
      await action.click()
      assert.equal(posts, 0)
      await saveAllowance(page)
      await waitFor(() => held)
      assert.equal(await action.isDisabled(), true)
      assert.equal(
        await page.getByRole('button', { name: 'Disable app access', exact: true }).isDisabled(),
        true,
      )
      await json(held, {})
      await page
        .getByRole('alert')
        .filter({ hasText: 'Allowance change could not be confirmed' })
        .waitFor()
      assert.equal(posts, 1)
      valid = true
      await saveAllowance(page)
      await page.getByRole('status').filter({ hasText: 'Upload allowance updated' }).waitFor()
      assert.equal(posts, 2)
    },
  )
  await scenario(
    'Access allowance cancels on departure and cannot affect the next screen',
    async (page) => {
      let held
      const data = overview(true)
      data.users[0].registration_source = 'public'
      await page.route('**/api/admin/access', (route) => json(route, data))
      await page.route('**/api/admin/customer-allowance', (route) => {
        held = route
      })
      await page.goto(origin + '/fixture/access')
      await page.getByRole('button', { name: 'Set upload allowance', exact: true }).click()
      await saveAllowance(page)
      await waitFor(() => held)
      // Exercise the actual client-side unmount/remount lifecycle. Reloading the
      // document discards React state and cannot prove the generation fence.
      await page.evaluate(() => {
        history.pushState(null, '', '/photos/1')
        dispatchEvent(new Event('fixture:navigate'))
      })
      await page.getByRole('button', { name: 'Return to album', exact: true }).waitFor()
      await page.evaluate(() => {
        history.pushState(null, '', '/fixture/access')
        dispatchEvent(new Event('fixture:navigate'))
      })
      await page.getByRole('heading', { name: 'Jane Fixture', exact: true }).waitFor()
      await json(held, { ok: true }).catch(() => {})
      await settled(page)
      assert.equal(
        await page.getByRole('status').filter({ hasText: 'Upload allowance updated' }).count(),
        0,
      )
      assert.equal(
        await page.getByRole('button', { name: 'Set upload allowance', exact: true }).isEnabled(),
        true,
      )
    },
  )
  await scenario(
    'Access overview handles malformed status and clears denied cached users',
    async (page) => {
      let mode = 'malformed'
      await page.route('**/api/admin/access', (route) =>
        mode === 'denied'
          ? route.fulfill({ status: 403, contentType: 'text/html', body: '<html>Denied</html>' })
          : json(route, mode === 'malformed' ? {} : overview(true)),
      )
      await page.goto(origin + '/fixture/access')
      await page.getByRole('alert').waitFor()
      mode = 'valid'
      await page.getByRole('button', { name: 'Refresh access', exact: true }).click()
      await page.getByRole('heading', { name: 'Jane Fixture', exact: true }).waitFor()
      mode = 'denied'
      await page.getByRole('button', { name: 'Refresh access', exact: true }).click()
      await page.getByRole('alert').waitFor()
      await settled(page)
      assert.equal(
        await page.getByRole('heading', { name: 'Jane Fixture', exact: true }).count(),
        0,
      )
    },
  )
  await scenario(
    'Access mutation supersedes old reads and retries the same operation ID',
    async (page) => {
      let hold = false
      let held
      let enabled = true
      let uncertain = true
      const posts = []
      await page.route('**/api/admin/access', (route) => {
        if (route.request().method() === 'POST') {
          posts.push(route.request().postDataJSON())
          enabled = false
          return json(
            route,
            uncertain ? {} : { message: 'App access disabled. New requests are denied.' },
          )
        }
        if (hold) {
          hold = false
          held = route
          return
        }
        return json(route, overview(enabled))
      })
      await page.goto(origin + '/fixture/access')
      await page.getByRole('button', { name: 'Disable app access', exact: true }).waitFor()
      hold = true
      await page.getByRole('button', { name: 'Refresh access', exact: true }).click()
      await waitFor(() => held)
      await page.getByRole('button', { name: 'Disable app access', exact: true }).click()
      await page.getByRole('button', { name: 'Retry this operation', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Enable app access', exact: true }).waitFor()
      await json(held, overview(true)).catch(() => {})
      await settled(page)
      assert.equal(
        await page.getByRole('button', { name: 'Disable app access', exact: true }).count(),
        0,
      )
      uncertain = false
      await page.getByRole('button', { name: 'Retry this operation', exact: true }).click()
      await page.getByRole('status').filter({ hasText: 'App access disabled' }).waitFor()
      assert.equal(posts.length, 2)
      assert.deepEqual(posts[1], posts[0], 'Uncertain operations must retry exact request and ID')
    },
  )
}
