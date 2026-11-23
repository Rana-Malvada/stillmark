import assert from 'node:assert/strict'

export async function processingProgressChecks({ scenario, origin, json, settled }) {
  for (const width of [390, 1280])
    await scenario(
      `Automatic processing keeps progress and warm status at ${width}px`,
      async (page) => {
        await page.setViewportSize({ width, height: 844 })
        const run = {
          id: '11111111-1111-4111-8111-111111111111',
          status: 'running',
          idle_since: new Date().toISOString(),
          created_at: new Date().toISOString(),
          total: 3,
          processed: 3,
          failed: 0,
          faces_found: 4,
        }
        await page.route('**/api/admin/face-scan', (r) => {
          assert.equal(r.request().method(), 'GET')
          return json(r, {
            run,
            summary: { total: 3, scanned: 3, pending: 0, failed: 0, owners: 1 },
            progress: { done: 3, running: 0, queued: 0, failed: 0 },
            failures: [],
            continuing: false,
            estimatedMinutes: 0,
          })
        })
        await page.route('**/api/admin/video-preparation', (r) => {
          assert.equal(r.request().method(), 'GET')
          return json(r, {
            run,
            summary: { total: 3, ready: 3, pending: 0, skipped: 0 },
            progress: { ready: 3, running: 0, queued: 0, failed: 0, skipped: 0 },
            failures: [],
            excluded: [],
          })
        })
        await page.route('**/api/admin/search-batch', (r) => {
          assert.equal(r.request().method(), 'GET')
          return json(r, {
            run,
            warmIdle: true,
            checkedAt: new Date().toISOString(),
            rankingEnabled: false,
            automaticPublishing: null,
            summary: { completed: 3, pending: 0, failed: 0, running: 0 },
            searches: { pending: 0 },
            pipeline: {
              rootId: run.id,
              status: 'running',
              message: 'Enriching photos',
              canRetryFollowup: false,
              active: true,
              stage: 0,
              canStop: true,
              photoLimit: 3,
              photosDone: 3,
              searchesDone: 0,
              failures: 0,
            },
          })
        })
        await page.goto(origin + '/admin/processing')
        await page.locator('style').evaluateAll((nodes) => nodes.forEach((n) => n.remove()))
        await page.addStyleTag({ url: origin + '/layout.css' })
        await settled(page)
        await page.getByRole('heading', { name: 'Search progress', exact: true }).waitFor()
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll('[role="status"]')].filter(
              (n) => n.textContent === 'Ready for new uploads',
            ).length === 3,
        )
        assert.equal(await page.getByRole('progressbar').count(), 3)
        assert.equal(
          await page
            .getByRole('button', {
              name: /^(Scan photos|Prepare videos|Run batch|Retry unfinished)/,
            })
            .count(),
          0,
        )
        assert.equal(
          await page
            .getByRole('link', { name: /^(Scan people|Prepare videos|Update Search)$/ })
            .count(),
          0,
        )
        const processing = page.getByRole('link', { name: 'Processing', exact: true })
        // Real Link classes participate in the narrow-screen overflow measurement.
        // The active section must remain reachable from More when it cannot fit.
        if (!(await processing.count()))
          await page
            .getByRole('navigation', { name: 'Activity sections' })
            .getByRole('button', { name: 'More', exact: true })
            .click()
        assert.equal(await processing.count(), 1)
        assert.equal(await processing.getAttribute('aria-current'), 'page')
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        )
      },
    )
}
