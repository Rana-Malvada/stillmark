import assert from 'node:assert/strict'

export async function reportMapChecks({ scenario, origin, json, costData }) {
  await scenario(
    'Report boundary: malformed report recovers without blank-page crash',
    async (page) => {
      let malformed = true
      await page.route('**/api/my-costs', (r) =>
        json(r, malformed ? { ...costData(), services: [{}] } : costData()),
      )
      await page.goto(origin + '/costs')
      await page.getByRole('alert').waitFor()
      malformed = false
      await page.getByRole('button', { name: 'Retry report' }).click()
      await page.getByRole('heading', { name: 'Compute subtotal' }).waitFor()
      assert.equal(await page.getByRole('alert').count(), 0)
    },
  )
  await scenario(
    'Report boundary: rapid refresh clicks start one durable refresh',
    async (page) => {
      let posts = 0
      let held
      await page.route('**/api/my-costs', (r) => json(r, costData()))
      await page.route('**/api/costs', (r) => {
        posts++
        held = r
      })
      await page.route('**/api/costs?*', (r) => json(r, { asOf: costData().asOf, sources: [] }))
      await page.goto(origin + '/costs')
      await page.getByRole('button', { name: 'Refresh', exact: true }).evaluate((b) => {
        b.click()
        b.click()
      })
      await page.getByRole('button', { name: 'Refreshing…', exact: true }).waitFor()
      await page.waitForFunction(() => true)
      const deadline = Date.now() + 5000
      while (!held) {
        assert.ok(Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.equal(posts, 1)
      await json(held, { asOf: costData(true).asOf })
      await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor()
    },
  )
  await scenario(
    'Travel boundary: malformed overview recovers with unchanged empty state',
    async (page) => {
      let malformed = true
      await page.route('**/api/travels?*', (r) => json(r, { stops: malformed ? null : [] }))
      await page.goto(origin + '/travels')
      await page.getByRole('alert').waitFor()
      malformed = false
      await page.getByRole('button', { name: 'Try again' }).click()
      await page.getByRole('heading', { name: 'Your next chapter starts here' }).waitFor()
    },
  )
  await scenario(
    'Travel boundary: invalid viewport keeps controls usable and retry recovers',
    async (page) => {
      let malformed = true
      await page.route('**/api/travels?*', (r) => json(r, { clusters: malformed ? {} : [] }))
      await page.goto(origin + '/travel-map')
      await page.getByRole('button', { name: 'Retry', exact: true }).waitFor()
      malformed = false
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
      await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'hidden' })
      assert.equal(await page.locator('.leaflet-container').count(), 1)
    },
  )
}
