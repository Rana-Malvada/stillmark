import assert from 'node:assert/strict'

const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for fixture request')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const run = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'running',
  created_at: '2026-11-21T00:00:00Z',
  finished_at: null,
  total: 3,
  processed: 0,
  failed: 0,
  faces_found: 0,
  error: null,
}
const faceStatus = (active) => ({
  run: active ? run : null,
  summary: { total: 3, scanned: 0, pending: 3, failed: 0, owners: 1 },
  progress: active ? { done: 0, running: 1, queued: 2, failed: 0 } : null,
  failures: [],
  statusWarning: null,
  continuing: false,
  estimatedMinutes: 1,
})
const videoStatus = (active) => ({
  run: active ? run : null,
  summary: { total: 3, ready: 0, pending: 3, skipped: 0 },
  progress: active ? { ready: 0, running: 1, queued: 2, failed: 0, skipped: 0 } : null,
  failures: [],
  excluded: [],
})
const activityStatus = (active) => ({
  summary: { active_ai: active ? 1 : 0 },
  asOf: active ? '2026-11-21T01:00:00Z' : '2026-11-21T00:00:00Z',
  sync: null,
  uploads: [],
  failures: [],
  cleanup: [{ path: 'fixture', attempts: 1, last_error: 'retry' }],
})
const personData = (name) => ({
  canEdit: true,
  faces: [
    {
      faceId: 1,
      photoId: 1,
      hasCrop: false,
      source: 'manual',
      status: 'confirmed',
      personId: 'person-one',
      personName: name,
    },
  ],
})
export async function maintainabilityChecks({ scenario, origin, json, settled }) {
  for (const spec of [
    {
      path: 'faces',
      api: '/api/admin/face-scan',
      status: faceStatus,
      action: 'Scan photos',
      active: 'Scanning',
    },
    {
      path: 'video',
      api: '/api/admin/video-preparation',
      status: videoStatus,
      action: 'Prepare videos',
      active: 'Preparing',
    },
    {
      path: 'activity',
      api: '/api/activity',
      status: activityStatus,
      action: 'Retry failed cleanup',
    },
  ])
    for (const failOldRead of [false, true])
      await scenario(
        `Quality ${spec.path} mutation refresh supersedes ${failOldRead ? 'failed' : 'stale'} read`,
        async (page) => {
          let hold = false
          let held
          let reads = 0
          let posts = 0
          let active = false
          await page.route('**' + spec.api, async (route) => {
            if (route.request().method() === 'POST') {
              posts++
              active = true
              return json(route, { ok: true })
            }
            reads++
            if (hold) {
              hold = false
              held = route
              return
            }
            return json(route, spec.status(active))
          })
          await page.goto(origin + '/fixture/' + spec.path)
          await page.getByRole('button', { name: spec.action, exact: true }).waitFor()
          await settled(page)
          // A visible-tab status refresh is deliberately held while the mutation commits.
          hold = true
          await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
          await waitFor(() => held)
          const before = reads
          await page.getByRole('button', { name: spec.action, exact: true }).click()
          await waitFor(() => posts === 1)
          await waitFor(() => reads > before)
          if (failOldRead)
            await held
              .fulfill({
                status: 502,
                contentType: 'text/html',
                body: '<html>Gateway</html>',
              })
              .catch(() => {})
          else await json(held, spec.status(false)).catch(() => {})
          await waitFor(() => reads > before)
          if (spec.active) await page.getByRole('status').filter({ hasText: spec.active }).waitFor()
          else
            await page
              .getByText('Request accepted. Status updates automatically.', { exact: true })
              .waitFor()
          assert.equal(await page.locator('p[role="alert"]').count(), 0)
          const fresh = reads
          await page.waitForTimeout(5200)
          assert.ok(reads > fresh, 'Active status must continue polling')
        },
      )

  for (const [path, api, status] of [
    ['faces', '/api/admin/face-scan', faceStatus],
    ['video', '/api/admin/video-preparation', videoStatus],
    ['activity', '/api/activity', activityStatus],
  ])
    await scenario(`Quality ${path} malformed status is visible and retryable`, async (page) => {
      let failed = true
      await page.route('**' + api, (route) => json(route, failed ? { summary: {} } : status(false)))
      await page.goto(origin + '/fixture/' + path)
      await page.locator('p[role="alert"]').waitFor()
      failed = false
      await page
        .getByRole('button', { name: path === 'activity' ? 'Retry' : 'Refresh', exact: true })
        .click()
      await page.waitForFunction(() => document.querySelectorAll('p[role="alert"]').length === 0)
      await page
        .getByRole('button', {
          name: path === 'activity' ? 'Refresh status' : 'Refresh',
          exact: true,
        })
        .waitFor()
      assert.equal(await page.locator('p[role="alert"]').count(), 0)
    })

  for (const mode of ['network', 'html', 'malformed', 'forbidden'])
    await scenario(
      `Quality Trash retries destination ${mode} without clearing selection`,
      async (page) => {
        let failed = true
        let trashReads = 0
        await page.route('**/api/trash?*', (r) => {
          trashReads++
          return json(r, {
            files: [
              { photoId: 1, filename: 'kept.jpg', albumName: 'Original', expiresAt: '2026-12-01' },
            ],
            hasMore: false,
          })
        })
        await page.route('**/api/trash/1/thumbnail', (r) => r.fulfill({ status: 404, body: '' }))
        await page.route('**/api/events?*', (r) =>
          failed
            ? fail(r, mode, json)
            : json(r, {
                items: [{ eventId: 7, eventName: 'Recovered album', canEdit: true }],
                nextCursor: null,
              }),
        )
        await page.goto(origin + '/fixture/trash')
        await page.getByRole('button', { name: 'Retry albums', exact: true }).waitFor()
        await page.getByRole('checkbox').check()
        const before = trashReads
        failed = false
        await page.getByRole('button', { name: 'Retry albums', exact: true }).click()
        await page.getByRole('option', { name: 'Recovered album' }).waitFor({ state: 'attached' })
        assert.equal(await page.getByRole('checkbox').isChecked(), true)
        assert.equal(trashReads, before)
        assert.equal(await page.locator('p[role="alert"]').count(), 0)
      },
    )
  await scenario(
    'Quality Trash retries the failed destination cursor and keeps earlier options',
    async (page) => {
      let failed = true
      await page.route('**/api/trash?*', (r) => json(r, { files: [], hasMore: false }))
      await page.route('**/api/events?*', (r) => {
        const cursor = new URL(r.request().url()).searchParams.get('cursor')
        if (!cursor)
          return json(r, {
            items: [{ eventId: 7, eventName: 'First album', canEdit: true }],
            nextCursor: 'second',
          })
        assert.equal(cursor, 'second')
        return failed
          ? fail(r, 'html', json)
          : json(r, {
              items: [{ eventId: 8, eventName: 'Second album', canEdit: true }],
              nextCursor: null,
            })
      })
      await page.goto(origin + '/fixture/trash')
      await page.getByRole('button', { name: 'Load more albums', exact: true }).click()
      await page.getByRole('button', { name: 'Retry albums', exact: true }).waitFor()
      failed = false
      await page.getByRole('button', { name: 'Retry albums', exact: true }).click()
      await page.getByRole('option', { name: 'Second album' }).waitFor({ state: 'attached' })
      assert.equal(await page.getByRole('option', { name: 'First album' }).count(), 1)
    },
  )

  for (const mode of ['network', 'html', 'malformed', 'forbidden'])
    await scenario(
      `Quality album editor recovers folder ${mode} without losing edits`,
      async (page) => {
        let failed = true
        await page.route('**/api/folders', (r) =>
          failed
            ? fail(r, mode, json)
            : json(r, [
                { folderId: 1, folderName: 'Allowed folder', canSelect: true, canEdit: true },
                { folderId: 2, folderName: 'Not selectable', canSelect: false, canEdit: false },
              ]),
        )
        await page.goto(origin + '/fixture/album-editor')
        await page.getByRole('button', { name: 'Edit details', exact: true }).click()
        await page.getByRole('button', { name: 'Retry folders', exact: true }).waitFor()
        await page.getByRole('textbox', { name: 'Album name', exact: true }).fill('Keep this edit')
        failed = false
        await page.getByRole('button', { name: 'Retry folders', exact: true }).click()
        await page.getByRole('option', { name: 'Allowed folder' }).waitFor({ state: 'attached' })
        assert.equal(
          await page.getByRole('textbox', { name: 'Album name', exact: true }).inputValue(),
          'Keep this edit',
        )
        assert.equal(await page.getByRole('option', { name: 'Not selectable' }).count(), 0)
        assert.equal(
          await page.getByRole('combobox', { name: 'Folder', exact: true }).inputValue(),
          '1',
        )
      },
    )
  await scenario('Quality album editor discards a response from a closed dialog', async (page) => {
    let old
    let hold = true
    await page.route('**/api/folders', (r) => {
      if (hold) {
        hold = false
        old = r
        return
      }
      return json(r, [
        { folderId: 1, folderName: 'Current folders', canSelect: true, canEdit: true },
      ])
    })
    await page.goto(origin + '/fixture/album-editor')
    await page.getByRole('button', { name: 'Edit details', exact: true }).click()
    await waitFor(() => old)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Edit details', exact: true }).click()
    await page.getByRole('option', { name: 'Current folders' }).waitFor({ state: 'attached' })
    await json(old, [
      { folderId: 9, folderName: 'Obsolete folders', canSelect: true, canEdit: true },
    ]).catch(() => {})
    await settled(page)
    assert.equal(await page.getByRole('option', { name: 'Obsolete folders' }).count(), 0)
  })

  await scenario(
    'Quality photo people accepts shared-viewer privacy-reduced face data',
    async (page) => {
      await page.route('**/api/photos/1/people', (route) =>
        json(route, {
          canEdit: false,
          faces: [
            { faceId: 1, hasCrop: false, personId: 'person-one', personName: 'Shared Alice' },
          ],
        }),
      )
      await page.goto(origin + '/fixture/photo-people')
      await page.getByRole('link', { name: 'Shared Alice', exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Retry people', exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: /Edit people/ }).count(), 0)
    },
  )

  for (const mode of ['network', 'html', 'malformed'])
    await scenario(`Quality photo people initial ${mode} is recoverable`, async (page) => {
      let failed = true
      await page.route('**/api/photos/1/people', (r) =>
        failed ? fail(r, mode, json) : json(r, personData('Alice')),
      )
      await page.goto(origin + '/fixture/photo-people')
      await page.getByRole('button', { name: 'Retry people', exact: true }).waitFor()
      failed = false
      await page.getByRole('button', { name: 'Retry people', exact: true }).click()
      await page.getByRole('link', { name: 'Alice', exact: true }).waitFor()
      assert.equal(await page.locator('p[role="alert"]').count(), 0)
    })
  await scenario(
    'Quality photo people preserves transient data but clears revoked access',
    async (page) => {
      let mode = 'ok'
      await page.route('**/api/photos/1/people', (r) =>
        mode === 'ok' ? json(r, personData('Alice')) : fail(r, mode, json),
      )
      await page.goto(origin + '/fixture/photo-people')
      await page.getByRole('link', { name: 'Alice', exact: true }).waitFor()
      mode = 'html'
      await page.getByRole('button', { name: 'Refresh people', exact: true }).click()
      await page.getByRole('button', { name: 'Retry people', exact: true }).waitFor()
      assert.equal(await page.getByRole('link', { name: 'Alice', exact: true }).count(), 1)
      mode = 'forbidden'
      await page.getByRole('button', { name: 'Retry people', exact: true }).click()
      await page.waitForFunction(
        () => ![...document.querySelectorAll('a')].some((n) => n.textContent === 'Alice'),
      )
    },
  )
  await scenario('Quality photo people ignores late data after switching photos', async (page) => {
    let held
    await page.route('**/api/photos/*/people', (r) => {
      if (r.request().url().endsWith('/1/people')) {
        held = r
        return
      }
      return json(r, personData('Bob'))
    })
    await page.goto(origin + '/fixture/photo-people')
    await waitFor(() => held)
    await page.getByRole('button', { name: 'Change photo', exact: true }).click()
    await page.getByRole('link', { name: 'Bob', exact: true }).waitFor()
    await json(held, personData('Alice')).catch(() => {})
    await settled(page)
    assert.equal(await page.getByRole('link', { name: 'Alice', exact: true }).count(), 0)
  })
  await scenario(
    'Quality search status rejects malformed successful response and recovers',
    async (page) => {
      let failed = true
      await page.route('**/api/admin/search-batch', (r) =>
        json(
          r,
          failed
            ? { summary: {} }
            : {
                summary: { pending: 0, completed: 0, failed: 0, running: 0 },
                searches: { pending: 0 },
                run: null,
                pipeline: null,
                warmIdle: false,
                automaticPublishing: null,
                rankingEnabled: false,
                checkedAt: new Date().toISOString(),
              },
        ),
      )
      await page.goto(origin + '/fixture/search-status')
      await page.getByRole('alert').waitFor()
      failed = false
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click()
      await page.getByRole('status').filter({ hasText: 'Up to date' }).waitFor()
      assert.equal(await page.locator('p[role="alert"]').count(), 0)
    },
  )
}
async function fail(route, mode, json) {
  if (mode === 'network') return route.abort('connectionfailed')
  if (mode === 'html')
    return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Gateway</html>' })
  if (mode === 'malformed') return json(route, { invalid: true })
  return json(route, { error: 'Access denied' }, 403)
}
