import assert from 'node:assert/strict'

const status = (count = 10) => ({
  total_photos: count,
  total_videos: 0,
  photos_with_ai: count,
  photos_without_ai: 0,
  photos_failed: 1,
  in_search: count,
  pending_sync: 0,
  pending_search_removals: 0,
  failed_photos: [{ photo_id: '7', source_filename: 'fixture.jpg', ai_error: null }],
})
export async function galleryStatusChecks({ scenario, origin, json, settled }) {
  async function open(page, role = 'admin') {
    await page.route('**/api/favorites?*', (route) => json(route, { items: [], nextCursor: null }))
    await page.goto(origin + '/favorites?fixtureHeader=1&fixtureRole=' + role)
    await page.locator('style').evaluateAll((styles) => styles.forEach((s) => s.remove()))
    await page.addStyleTag({ url: origin + '/layout.css' })
    await page.getByRole('button', { name: 'Gallery status', exact: true }).click()
    return page.getByRole('region', { name: 'Gallery statistics' })
  }
  await scenario(
    'Gallery stats malformed success is retryable without shifting header',
    async (page) => {
      let bad = true
      await page.route('**/api/stats', (route) =>
        json(route, bad ? { total_photos: 10 } : status()),
      )
      const panel = await open(page)
      await panel.getByRole('alert').waitFor()
      const box = await page.locator('.app-header').boundingBox()
      bad = false
      await panel.getByRole('button', { name: 'Retry status' }).click()
      await panel.getByText('Search copy acknowledged', { exact: true }).waitFor()
      assert.deepEqual(await page.locator('.app-header').boundingBox(), box)
    },
  )
  await scenario(
    'Gallery stats closing aborts old reads and reopening fetches fresh state',
    async (page) => {
      let hold = true
      let held
      await page.route('**/api/stats', async (route) => {
        if (hold) {
          held = route
          return
        }
        return json(route, status(20))
      })
      const panel = await open(page)
      await panel.getByRole('status').waitFor()
      // WebKit pointer clicks do not necessarily focus the trigger. Exercise
      // the same page-focus state in every browser, not only Safari.
      await page
        .getByRole('button', { name: 'Gallery status', exact: true })
        .evaluate((button) => button.blur())
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'hidden' })
      hold = false
      await page.getByRole('button', { name: 'Gallery status', exact: true }).click()
      await panel.getByText('20', { exact: true }).first().waitFor()
      if (held) await json(held, status(99)).catch(() => {})
      await settled(page)
      assert.equal(await panel.getByText('99', { exact: true }).count(), 0)
    },
  )
  await scenario(
    'Gallery stats accepted mutation with failed refresh never reposts on status retry',
    async (page) => {
      let failRead = false
      let posts = 0
      await page.route('**/api/stats', (route) =>
        failRead ? json(route, { error: 'unavailable' }, 503) : json(route, status()),
      )
      await page.route('**/api/search-sync', (route) => {
        posts++
        failRead = true
        return json(route, { ok: true })
      })
      const panel = await open(page)
      await panel.getByRole('button', { name: 'Sync Search', exact: true }).click()
      await panel
        .getByText(
          'Request accepted, but status could not be refreshed. Retry status to check progress.',
        )
        .waitFor()
      failRead = false
      await panel.getByRole('button', { name: 'Retry status' }).click()
      await settled(page)
      assert.equal(posts, 1)
      assert.equal(await panel.getByRole('alert').count(), 0)
    },
  )
  await scenario(
    'Gallery stats duplicate activation sends one request and revocation clears counts',
    async (page) => {
      let revoked = false
      let posts = 0
      let complete
      await page.route('**/api/stats', (route) =>
        revoked ? json(route, { error: 'Forbidden' }, 403) : json(route, status()),
      )
      await page.route('**/api/search-sync', async (route) => {
        posts++
        await new Promise((resolve) => {
          complete = resolve
        })
        revoked = true
        await json(route, { ok: true })
      })
      const panel = await open(page)
      const sync = panel.getByRole('button', { name: 'Sync Search', exact: true })
      await sync.waitFor()
      await sync.evaluate((button) => {
        button.click()
        button.click()
      })
      await panel.getByRole('button', { name: 'Syncing...' }).waitFor()
      const deadline = Date.now() + 5000
      while (!complete) {
        assert.ok(Date.now() < deadline, 'Mutation request did not arrive')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(posts, 1)
      complete()
      await panel.getByRole('alert').waitFor()
      assert.equal(await panel.getByText('Search copy acknowledged', { exact: true }).count(), 0)
    },
  )
  await scenario('Gallery stats read-only admin can inspect but cannot mutate', async (page) => {
    await page.route('**/api/stats', (route) => json(route, status()))
    const panel = await open(page, 'admin_readonly')
    assert.equal(
      await panel.getByRole('button', { name: 'Sync Search', exact: true }).isDisabled(),
      true,
    )
    assert.equal(
      await panel.getByRole('button', { name: 'Retry description', exact: true }).isDisabled(),
      true,
    )
  })
}
