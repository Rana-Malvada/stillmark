import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const faces = Array.from({ length: 120 }, (_, i) => ({
  faceId: i + 1,
  photoId: i + 1,
  hasCrop: false,
  status: 'confirmed',
}))
const group = (i) => ({
  personId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  name: null,
  hidden: false,
  coverFaceId: null,
  photoCount: i + 1,
  reviewCount: 0,
})
const overview = {
  named: [],
  unnamed: Array.from({ length: 36 }, (_, i) => group(i)),
  hidden: [],
  unknownCount: 120,
  reviewCount: 120,
  lowerConfidenceCount: 0,
  ignoredCount: 0,
  unnamedCount: 36,
  peopleCount: 36,
  more: false,
}

// Geometry checks use the real compiled application stylesheet, not fixture CSS.
export async function selectionLayoutChecks({ scenario, origin, json, settled, person }) {
  const artifacts = process.env.CLIENT_LAYOUT_ARTIFACTS
  if (artifacts) await mkdir(artifacts, { recursive: true })
  async function style(page) {
    await page.locator('style').evaluateAll((styles) => styles.forEach((s) => s.remove()))
    await page.addStyleTag({ url: origin + '/layout.css' })
    await settled(page)
  }
  async function geometry(page, tile) {
    return { box: await tile.boundingBox(), scroll: await page.evaluate(() => scrollY) }
  }
  async function stable(page, tile, before, action) {
    await action()
    await settled(page)
    const after = await geometry(page, tile)
    for (const key of ['x', 'y', 'width', 'height'])
      assert.ok(
        Math.abs(after.box[key] - before.box[key]) < 1,
        `${key} changed by ${after.box[key] - before.box[key]}px`,
      )
    assert.equal(after.scroll, before.scroll, 'Scroll position changed')
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Horizontal overflow',
    )
  }
  async function openActions(dock) {
    const button = dock.getByRole('button', { name: 'Actions', exact: true })
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  }
  async function compact(dock) {
    assert.ok(
      (await dock.boundingBox()).height <= 66,
      'Closed toolbar must fit one touch-sized row',
    )
    assert.equal(await dock.getByRole('button', { name: 'Clear', exact: true }).isVisible(), false)
  }
  async function unobstructed(control) {
    assert.equal(
      await control.evaluate((el) => {
        const box = el.getBoundingClientRect()
        return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      }),
      true,
      'Menu control must be above the selection bar and clickable',
    )
  }
  for (const width of [320, 390, 1280]) {
    await scenario(`Media-first header and person layout at ${width}px`, async (page) => {
      await page.setViewportSize({ width, height: 844 })
      const data = person()
      data.person.name = 'Alex Morgan'
      data.person.photoCount = 36
      data.person.reviewCount = 3
      data.faces = faces.slice(0, 36)
      await page.route('**/api/people/**', (route) => json(route, data))
      await page.route('**/icon.svg', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          path: 'public/icon.svg',
        }),
      )
      await page.goto(origin + '/people/' + data.person.personId + '?fixtureHeader=1')
      await style(page)
      await page.locator('[data-selection-id]').first().waitFor()
      const header = page.locator('.app-header')
      if (width >= 640)
        assert.ok((await header.boundingBox()).height <= 74, 'App navigation must be one row')
      else
        assert.equal(
          await header.isVisible(),
          false,
          'Detail pages use their compact contextual toolbar',
        )
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      )
      if (width < 640) {
        assert.ok(
          (await page.locator('[data-selection-id]').first().boundingBox()).y < 240,
          'Faces must start near the top instead of below stacked controls',
        )
        await unobstructed(page.getByRole('button', { name: 'Back to People', exact: true }))
      }
      if (artifacts) {
        await page.locator('html').evaluate((el) => el.classList.add('dark'))
        await page.addStyleTag({ content: '* { transition: none !important; }' })
        await page.getByRole('heading', { name: 'Alex Morgan' }).click()
        await settled(page)
        await page.screenshot({ path: `${artifacts}/full-person-${width}-dark.png` })
        await page.locator('html').evaluate((el) => el.classList.remove('dark'))
        await page.screenshot({ path: `${artifacts}/full-person-${width}-light.png` })
      }
    })

    await scenario(`Main navigation is reachable at ${width}px`, async (page) => {
      await page.setViewportSize({ width, height: 844 })
      await page.route('**/api/favorites?*', (route) =>
        json(route, { items: [], nextCursor: null }),
      )
      await page.route('**/icon.svg', (route) =>
        route.fulfill({ contentType: 'image/svg+xml', path: 'public/icon.svg' }),
      )
      await page.goto(origin + '/favorites?fixtureHeader=1')
      await style(page)
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      )
      if (width < 640) {
        const nav = page.getByRole('button', { name: 'Navigation', exact: true })
        await unobstructed(nav)
        await nav.click()
        const destination = page.getByRole('link', { name: 'My Albums', exact: true })
        await unobstructed(destination)
        await page.keyboard.press('Escape')
        assert.equal(await nav.getAttribute('aria-expanded'), 'false')
        const header = page.locator('.app-header')
        assert.ok(
          (await header.boundingBox()).height <= 60,
          'Mobile header must be a single compact row',
        )
        assert.equal(await page.locator('.mobile-destinations').count(), 0, 'No bottom app menu')
        assert.equal(await nav.innerText(), 'Favorites', 'Picker identifies the current section')
        assert.equal(
          await page.evaluate(() => getComputedStyle(document.body).paddingBottom),
          '0px',
          'No obsolete bottom-menu spacer',
        )
        // Expand/collapse the available browser viewport without moving the toolbar
        // to the bottom or changing the document beneath the menu.
        for (const height of [620, 844, 700]) {
          await page.setViewportSize({ width, height })
          const content = page.locator('.selection-toolbar').first()
          const before = await geometry(page, content)
          await nav.click()
          await page.getByRole('link', { name: 'People', exact: true }).waitFor()
          await unobstructed(page.getByRole('link', { name: 'People', exact: true }))
          const popup = page.locator(`[id="${await nav.getAttribute('aria-controls')}"]`)
          const box = await popup.boundingBox()
          assert.ok(box.y >= (await header.boundingBox()).height, 'Menu anchors below header')
          assert.ok(box.y + box.height <= height, 'Menu stays inside available viewport')
          assert.deepEqual(
            await geometry(page, content),
            before,
            'Menu must overlay without shifting content',
          )
          await page.keyboard.press('Escape')
          await unobstructed(page.getByRole('button', { name: 'Search library', exact: true }))
          await unobstructed(page.getByRole('link', { name: 'Upload photos', exact: true }))
        }
        await page.setViewportSize({ width, height: 844 })
        await page.route('**/api/stats', (route) =>
          json(route, {
            total_photos: 10,
            total_videos: 0,
            photos_with_ai: 10,
            photos_without_ai: 0,
            photos_failed: 0,
            in_search: 10,
            pending_sync: 0,
            failed_photos: [],
          }),
        )
        await page.getByRole('button', { name: 'Gallery status', exact: true }).click()
        await page.getByText('Search copy acknowledged', { exact: true }).waitFor()
        assert.equal(await nav.getAttribute('aria-expanded'), 'false')
        await nav.click()
        await page.keyboard.press('Escape')
      } else {
        await unobstructed(
          page
            .getByRole('navigation', { name: 'Main navigation' })
            .getByRole('link', { name: 'People', exact: true }),
        )
      }
      const stats = page.getByRole('button', { name: 'Gallery status', exact: true })
      assert.equal(await stats.count(), 1, 'Stats has one direct header control')
      await unobstructed(stats)
      const searchBox = await page
        .getByRole('button', { name: 'Search library', exact: true })
        .boundingBox()
      const statsBox = await stats.boundingBox()
      assert.ok(Math.abs(searchBox.y - statsBox.y) < 1, 'Stats stays on the Search row')
      assert.ok(statsBox.x >= searchBox.x + searchBox.width, 'Stats follows Search')
      assert.ok(statsBox.x - searchBox.x - searchBox.width <= 12, 'Stats sits beside Search')
      if (artifacts) await page.screenshot({ path: `${artifacts}/navigation-${width}.png` })
    })

    await scenario(
      `Member navigation exposes only permitted destinations at ${width}px`,
      async (page) => {
        await page.setViewportSize({ width, height: 700 })
        await page.route('**/api/favorites?*', (route) =>
          json(route, { items: [], nextCursor: null }),
        )
        await page.goto(origin + '/favorites?fixtureHeader=1&fixtureRole=viewer')
        await style(page)
        if (width < 640) await page.getByRole('button', { name: 'Navigation', exact: true }).click()
        for (const name of [
          'Library',
          'My Albums',
          'People',
          'Places',
          'Favorites',
          'Costs',
          'Trash',
        ])
          assert.equal(await page.getByRole('link', { name, exact: true }).isVisible(), true)
        for (const name of ['Activity', 'Users & Roles'])
          assert.equal(await page.getByRole('link', { name, exact: true }).count(), 0)
        assert.equal(
          await page.getByRole('button', { name: 'Gallery status', exact: true }).count(),
          0,
        )
      },
    )

    await scenario(`Places prioritizes the map at ${width}px`, async (page) => {
      await page.setViewportSize({ width, height: 844 })
      await page.route('**/api/travels?*', (route) =>
        json(route, {
          stops: [
            {
              eventId: 7,
              album: 'Test album',
              year: 2026,
              lat: 38,
              lng: -77,
              city: 'Washington',
              country: 'United States',
              count: 5,
              photoId: 1,
              thumbnail: null,
            },
          ],
          clusters: [],
        }),
      )
      await page.goto(origin + '/travels?fixtureHeader=1')
      await style(page)
      await page.locator('.travel-map').waitFor()
      assert.ok(
        (await page.locator('.travel-map').boundingBox()).y < 300,
        'Map must be visible before secondary statistics',
      )
      const details = page.locator('details').filter({ hasText: 'Map details & place names' })
      assert.equal(
        await details.getByRole('button', { name: 'Find place names', exact: true }).isVisible(),
        false,
      )
      await details.locator('summary').click()
      await details.getByRole('button', { name: 'Find place names', exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      )
      await details.locator('summary').click()
      if (artifacts) {
        await page.evaluate(() => scrollTo(0, 0))
        await page.screenshot({ path: `${artifacts}/places-${width}.png` })
      }
    })

    await scenario(`Travel overview keeps all locations visible at ${width}px`, async (page) => {
      await page.setViewportSize({ width, height: 900 })
      await page.route('**/api/travels?*', (route) =>
        json(route, {
          clusters: [
            { lat: 64, lng: -20 },
            { lat: 38, lng: -122 },
            { lat: -34, lng: 18 },
            { lat: 35, lng: 140 },
            { lat: -34, lng: 151 },
            { lat: 48, lng: 2 },
          ].map((p, i) => ({
            ...p,
            id: String(i),
            areaId: String(i),
            label: `Location ${i}`,
            count: 1000 + i,
            points: 1,
          })),
        }),
      )
      await page.goto(origin + '/travel-map')
      await style(page)
      await page.locator('.travel-count').first().waitFor()
      await settled(page)
      const bounds = await page.locator('.travel-map').boundingBox()
      if (artifacts)
        await page.screenshot({ animations: 'disabled', path: `${artifacts}/travel-${width}.png` })
      for (const marker of await page.locator('.travel-count').all()) {
        const box = await marker.boundingBox()
        assert.ok(
          box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width,
          `Longitude marker clipped: ${JSON.stringify({ box, bounds })}`,
        )
        assert.ok(
          box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height,
          `Latitude marker clipped: ${JSON.stringify({ box, bounds })}`,
        )
      }
      if (artifacts)
        await page.screenshot({ animations: 'disabled', path: `${artifacts}/travel-${width}.png` })
      // Resize after mount, as when rotating a phone or opening/closing fullscreen.
      await page.setViewportSize({ width: width === 1280 ? 390 : 1280, height: 900 })
      await settled(page)
      await page.waitForFunction(() => {
        const map = window.fixtureMap
        return map.getSize().x === document.querySelector('.travel-map').clientWidth
      })
      const positions = await page.evaluate(() => {
        const map = window.fixtureMap
        const size = map.getSize()
        return [
          [64, -20],
          [38, -122],
          [-34, 18],
          [35, 140],
          [-34, 151],
          [48, 2],
        ].map((latlng) => ({ point: map.latLngToContainerPoint(latlng), size }))
      })
      for (const { point, size } of positions)
        assert.ok(
          point.x >= 24 && point.x <= size.x - 24 && point.y >= 24 && point.y <= size.y - 24,
          `Marker circle clipped after resize: ${JSON.stringify({ point, size })}`,
        )
      await page.locator('summary[aria-label="Map options"]').click()
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click()
      await settled(page)
      assert.equal(await page.locator('dialog').evaluate((el) => el.matches(':modal')), true)
      await page.evaluate(() => window.fixtureMap.setView([40, -75], 8, { animate: false }))
      await page.locator('summary[aria-label="Map options"]').click()
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
      await settled(page)
      const manual = await page.evaluate(() => ({
        center: window.fixtureMap.getCenter(),
        zoom: window.fixtureMap.getZoom(),
      }))
      assert.ok(Math.abs(manual.center.lat - 40) < 0.01 && Math.abs(manual.center.lng + 75) < 0.01)
      assert.equal(manual.zoom, 8, 'Fullscreen exit must retain a manually chosen view')
      await page.locator('summary[aria-label="Map options"]').click()
      await page.getByRole('button', { name: 'Show all locations', exact: true }).click()
      await settled(page)
      assert.ok(
        await page.evaluate(() => window.fixtureMap.getZoom() < 4),
        'Reset restores overview',
      )
    })
    for (const kind of ['person', 'unknown', 'review', 'groups']) {
      await scenario(`${kind} selection stays stable at ${width}px`, async (page) => {
        await page.setViewportSize({ width, height: 900 })
        const data = { ...person(), faces }
        let releaseNames
        await page.route(/\/api\/people(?:\/|\?|$)/, (route) => {
          const url = new URL(route.request().url())
          if (route.request().method() === 'POST')
            return json(route, { error: 'Temporary failure; selection kept' }, 503)
          if (url.pathname.endsWith('/settings'))
            return json(route, { enabled: true, shareNames: true })
          if (url.pathname.endsWith('/unknown') || url.pathname.endsWith('/review'))
            return json(route, { faces, more: false })
          if (url.pathname === '/api/people/' + data.person.personId) return json(route, data)
          // Keep person choices pending: selection must stay stable during network latency too.
          if (kind === 'person')
            return new Promise((resolve) => {
              releaseNames = () => resolve(json(route, { named: [], more: false }))
            })
          return json(route, overview)
        })
        const path =
          kind === 'person'
            ? '/people/' + data.person.personId
            : kind === 'groups'
              ? '/people?filter=unnamed'
              : '/people?tab=' + kind
        await page.goto(origin + path)
        await style(page)
        const tile = page.locator('[data-selection-id]').first()
        await tile.waitFor()
        assert.equal(
          await page.locator('.selection-toolbar').isVisible(),
          true,
          'Toolbar exists before selection',
        )
        const before = await geometry(page, tile)
        if (kind === 'person') {
          if (artifacts)
            await page.screenshot({
              animations: 'disabled',
              path: `${artifacts}/person-${width}-overview.png`,
            })
          const personActions = page.getByRole('button', { name: 'Person actions', exact: true })
          await stable(page, tile, before, () => personActions.click())
          await unobstructed(page.getByRole('button', { name: 'Edit name', exact: true }))
          await stable(page, tile, before, () =>
            page.getByRole('button', { name: 'Edit name', exact: true }).click(),
          )
          await stable(page, tile, before, () =>
            page.getByRole('button', { name: 'Cancel', exact: true }).click(),
          )
          await stable(page, tile, before, () => page.keyboard.press('Escape'))
          assert.equal(await page.locator('#person-actions-panel').isVisible(), false)
        }
        const checkbox = page.getByRole('checkbox').first()
        await stable(page, tile, before, () => checkbox.locator('..').click())
        const dock = page.getByRole('region', {
          name: kind === 'groups' ? 'Selected groups' : 'Selected faces',
          exact: true,
        })
        await dock.waitFor()
        await compact(dock)
        await stable(page, tile, before, () => openActions(dock))
        if (releaseNames) {
          releaseNames()
          await page.getByRole('button', { name: 'Move to: choose a person' }).waitFor()
        }
        if (kind === 'groups') {
          await stable(page, tile, before, () =>
            dock.getByRole('button', { name: 'Assign groups: choose a person' }).click(),
          )
          await stable(page, tile, before, () =>
            dock.getByRole('button', { name: '+ Add a new person', exact: true }).click(),
          )
          await stable(page, tile, before, () =>
            dock.getByLabel('New person’s name', { exact: true }).fill('New name'),
          )
          await stable(page, tile, before, () =>
            dock.getByRole('button', { name: 'Cancel new person' }).click(),
          )
        }
        {
          await stable(page, tile, before, () =>
            dock
              .getByRole('button', {
                name: kind === 'groups' ? 'Ignore groups' : 'Ignore faces',
                exact: true,
              })
              .click(),
          )
          await page.getByRole('alert').waitFor()
          await stable(page, tile, before, async () => {})
          assert.equal(await checkbox.isChecked(), true, 'Failed mutation must retain selection')
          await stable(page, tile, before, () =>
            page.getByRole('button', { name: 'Dismiss', exact: true }).click(),
          )
        }
        await stable(page, tile, before, () => openActions(dock))
        await stable(page, tile, before, () =>
          dock.getByRole('button', { name: 'Clear', exact: true }).click(),
        )
        assert.equal(await dock.isVisible(), true, 'Toolbar must remain when selection is empty')
        const selectAll = page.getByRole('button', {
          name:
            kind === 'person'
              ? 'Select all on this page'
              : kind === 'groups'
                ? 'Select shown groups'
                : 'Select shown',
          exact: true,
        })
        if (!(await selectAll.isVisible())) {
          await page.getByRole('button', { name: 'Select faces', exact: true }).click()
          await openActions(dock)
        }
        await stable(page, tile, before, () => selectAll.click())
        assert.equal(
          await page.getByRole('checkbox', { checked: true }).count(),
          kind === 'groups' ? 36 : 120,
        )
        await stable(page, tile, before, () => openActions(dock))
        await stable(page, tile, before, () =>
          dock.getByRole('button', { name: 'Clear', exact: true }).click(),
        )
        // Select a visible tile after scrolling; the toolbar must not pull the page back up.
        const later = page.locator('[data-selection-id]').nth(24)
        await later.scrollIntoViewIfNeeded()
        const scrolled = await geometry(page, later)
        await stable(page, later, scrolled, () => later.locator('label').click())
        if (artifacts) {
          await page.screenshot({
            animations: 'disabled',
            path: `${artifacts}/${kind}-${width}-light.png`,
          })
          await page.evaluate(() => document.documentElement.classList.add('dark'))
          await page.screenshot({
            animations: 'disabled',
            path: `${artifacts}/${kind}-${width}-dark.png`,
          })
        }
        await stable(page, later, scrolled, () => openActions(dock))
        await stable(page, later, scrolled, () =>
          dock.getByRole('button', { name: 'Clear', exact: true }).click(),
        )
        releaseNames?.()
      })
    }
    for (const gallery of ['album', 'favorites'])
      await scenario(`${gallery} photo selection stays stable at ${width}px`, async (page) => {
        await page.setViewportSize({ width, height: 900 })
        await page.route(
          gallery === 'album' ? '**/api/events/7?*' : '**/api/favorites?*',
          (route) =>
            json(route, {
              items: faces.map((f) => ({
                photoId: f.photoId,
                sourceFilename: `Photo ${f.photoId}`,
                thumbnailUrl: null,
                mediaType: 'image',
                aspectRatio: 1,
                eventId: 7,
                favorite: false,
                canEdit: true,
              })),
              nextCursor: null,
            }),
        )
        await page.route('**/api/events?*', (route) =>
          json(route, {
            items: [{ eventId: 8, eventName: 'Destination', canEdit: true }],
            nextCursor: null,
          }),
        )
        await page.goto(origin + (gallery === 'album' ? '/events/7' : '/favorites'))
        await style(page)
        const tile = page.locator('.photo-tile').first()
        await tile.waitFor()
        assert.equal(await page.getByRole('region', { name: 'Selected photos' }).isVisible(), true)
        const before = await geometry(page, tile)
        await stable(page, tile, before, () => tile.hover())
        assert.equal(
          await tile.evaluate((el) => getComputedStyle(el).transform),
          'none',
          'Hover feedback must not move photos or animate their geometry',
        )
        await stable(page, tile, before, () => page.mouse.move(0, 0))
        assert.equal(
          await page.getByRole('button', { name: 'Actions', exact: true }).isVisible(),
          false,
          'Do not show selection actions while browsing',
        )
        assert.equal(
          await page.locator('#album-filter-panel').isVisible(),
          false,
          'Filters start collapsed in albums and Favorites',
        )
        if (gallery === 'favorites') {
          const filter = page.getByRole('button', { name: 'Filter & Sort', exact: true })
          await stable(page, tile, before, () => filter.click())
          await stable(page, tile, before, () => filter.click())
          assert.equal(
            await page.locator('#album-filter-panel').isVisible(),
            false,
            'Clicking Sort again closes it',
          )
          await stable(page, tile, before, () => filter.click())
          const filterBox = await page.locator('#album-filter-panel').boundingBox()
          assert.ok(filterBox.x >= 0 && filterBox.x + filterBox.width <= width)
          if (artifacts)
            await page.screenshot({
              animations: 'disabled',
              path: `${artifacts}/favorites-${width}-filters.png`,
            })
          await stable(page, tile, before, () => page.keyboard.press('Escape'))
          assert.equal(await page.locator('#album-filter-panel').isVisible(), false)
          await stable(page, tile, before, () => filter.click())
          await stable(page, tile, before, () => page.mouse.click(1, 90))
          assert.equal(await page.locator('#album-filter-panel').isVisible(), false)
          await filter.click()
          await page.locator('select[name="sort"]').selectOption('newest')
          await page.locator('select[name="media"]').selectOption('video')
          const filtered = page.waitForResponse((response) => {
            const url = new URL(response.url())
            return (
              url.pathname === '/api/favorites' &&
              url.searchParams.get('sort') === 'newest' &&
              url.searchParams.get('media') === 'video'
            )
          })
          await page.getByRole('button', { name: 'Apply', exact: true }).click()
          await filtered
          await tile.waitFor()
          await stable(page, tile, before, async () => {})
          assert.equal(await page.locator('#album-filter-panel').isVisible(), false)
          await filter.click()
          const reset = page.waitForResponse((response) => {
            const url = new URL(response.url())
            return (
              url.pathname === '/api/favorites' &&
              !url.searchParams.has('sort') &&
              !url.searchParams.has('media')
            )
          })
          await page.getByRole('button', { name: 'Reset', exact: true }).click()
          await reset
          await tile.waitFor()
          await stable(page, tile, before, async () => {})
          assert.equal(await page.locator('#album-filter-panel').isVisible(), false)
        }
        if (gallery === 'album') {
          for (const [name, panelId, firstControl] of [
            ['More', '#album-more-panel', 'Edit details'],
            ['Add', '#album-add-panel', 'Upload photos'],
            ['Filter & Sort', '#album-filter-panel', null],
          ]) {
            const trigger = page.getByRole('button', { name, exact: true })
            await stable(page, tile, before, () => trigger.click())
            const overlay = page.locator(panelId)
            await unobstructed(
              firstControl
                ? overlay.getByRole('button', { name: firstControl, exact: true })
                : overlay.locator('select').first(),
            )
            if (artifacts)
              await page.screenshot({
                animations: 'disabled',
                path: `${artifacts}/album-${width}-${name.replaceAll(' ', '-')}.png`,
              })
            await stable(page, tile, before, () => page.keyboard.press('Escape'))
            assert.equal(await overlay.isVisible(), false)
          }
        }
        await stable(page, tile, before, () =>
          page.getByRole('button', { name: 'Select photos', exact: true }).click(),
        )
        await stable(page, tile, before, () =>
          page.getByRole('button', { name: 'Select Photo 1', exact: true }).click(),
        )
        const dock = page.getByRole('region', { name: 'Selected photos' })
        assert.equal(
          await page.locator('.media-sort').isVisible(),
          false,
          'Browsing filters cannot overlap selection actions',
        )
        await compact(dock)
        await stable(page, tile, before, () => openActions(dock))
        const panel = dock.locator('div.selection-actions-panel:not([hidden])')
        const panelBox = await panel.boundingBox()
        const barBox = await dock.boundingBox()
        assert.ok(panelBox.y >= barBox.y + barBox.height, 'Actions stay anchored below toolbar')
        assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= width, 'Actions fit viewport')
        // Native Safari pointer activation can leave focus on the document.
        // Escape must close the open menu even without focus inside the toolbar.
        await page.evaluate(() => document.activeElement?.blur())
        await stable(page, tile, before, () => page.keyboard.press('Escape'))
        assert.equal(
          await dock
            .getByRole('button', { name: 'Actions', exact: true })
            .evaluate((el) => el === document.activeElement),
          true,
        )
        await compact(dock)
        await stable(page, tile, before, () => openActions(dock))
        await stable(page, tile, before, () =>
          dock.getByRole('button', { name: 'Select all shown', exact: true }).click(),
        )
        await stable(page, tile, before, () =>
          dock.getByText('Move to album', { exact: true }).click(),
        )
        await stable(page, tile, before, () =>
          dock.getByText('Move to album', { exact: true }).click(),
        )
        if (artifacts)
          await page.screenshot({
            animations: 'disabled',
            path: `${artifacts}/${gallery}-${width}-actions.png`,
          })
        await stable(page, tile, before, () => page.mouse.click(1, 90))
        assert.equal(await panel.isVisible(), false, 'Outside click dismisses actions')
        await stable(page, tile, before, () =>
          dock.getByRole('button', { name: 'Done selecting', exact: true }).click(),
        )
        await compact(dock)
        if (artifacts) {
          await page.screenshot({
            animations: 'disabled',
            path: `${artifacts}/${gallery}-${width}.png`,
          })
          await page.evaluate(() => document.documentElement.classList.add('dark'))
          await page.screenshot({
            animations: 'disabled',
            path: `${artifacts}/${gallery}-${width}-dark.png`,
          })
        }
      })
    for (const role of ['viewer', 'admin_readonly']) {
      await scenario(
        `${role} read-only album selection cannot expose edits at ${width}px`,
        async (page) => {
          await page.setViewportSize({ width, height: 900 })
          await page.route('**/api/events/7?*', (route) =>
            json(route, {
              items: [
                {
                  photoId: 1,
                  sourceFilename: 'Photo 1',
                  thumbnailUrl: null,
                  mediaType: 'image',
                  aspectRatio: 1,
                  eventId: 7,
                  favorite: false,
                  canEdit: false,
                },
              ],
              nextCursor: null,
            }),
          )
          await page.goto(`${origin}/events/7?fixtureRole=${role}&fixtureCanEdit=false`)
          await style(page)
          await page.getByRole('button', { name: 'Select photos', exact: true }).click()
          await page.getByRole('button', { name: 'Select Photo 1', exact: true }).click()
          const dock = page.getByRole('region', { name: 'Selected photos' })
          assert.equal(
            await page.locator('.media-sort').isVisible(),
            false,
            'Browsing filters cannot overlap selection actions',
          )
          await compact(dock)
          await openActions(dock)
          for (const name of ['Favorite', 'Unfavorite'])
            assert.equal(await dock.getByRole('button', { name, exact: true }).isDisabled(), true)
          assert.equal(await dock.getByRole('button', { name: 'Share selected' }).count(), 0)
          if (role === 'admin_readonly') {
            assert.equal(
              await dock.getByRole('button', { name: 'Move to Trash', exact: true }).isDisabled(),
              true,
            )
            await dock.getByText('Move to album', { exact: true }).click()
            assert.equal(
              await dock.getByLabel('Destination album', { exact: true }).isDisabled(),
              true,
            )
          } else {
            assert.equal(await dock.getByText('Move to album', { exact: true }).count(), 0)
            assert.equal(
              await dock.getByRole('button', { name: 'Move to Trash', exact: true }).count(),
              0,
            )
          }
          const personData = { ...person(), faces: faces.slice(0, 3) }
          await page.route('**/api/people/*', (route) => json(route, personData))
          await page.goto(`${origin}/people/${personData.person.personId}?fixtureRole=${role}`)
          await style(page)
          await page.getByRole('heading', { name: personData.person.name, exact: true }).waitFor()
          assert.equal(
            await page.getByRole('button', { name: 'Person actions', exact: true }).count(),
            role === 'admin_readonly' ? 0 : 1,
          )
          // Ordinary users can manage their own People even when the album above is shared read-only.
          assert.equal(await page.getByRole('checkbox').count(), role === 'admin_readonly' ? 0 : 3)
        },
      )
    }
    await scenario(
      `People navigation remains available while loading at ${width}px`,
      async (page) => {
        await page.setViewportSize({ width, height: 900 })
        let finish
        await page.route(/\/api\/people(?:\/|\?|$)/, (route) => {
          const url = new URL(route.request().url())
          if (url.pathname.endsWith('/settings'))
            return json(route, { enabled: true, shareNames: true })
          if (url.searchParams.get('kind') === 'unnamed')
            return new Promise((resolve) => {
              finish = () => resolve(json(route, overview))
            })
          return json(route, overview)
        })
        await page.goto(origin + '/people')
        await style(page)
        const nav = page.getByRole('navigation', { name: 'People views' })
        await nav.waitFor()
        await page.getByText('No people in this category.', { exact: true }).waitFor()
        const before = await geometry(page, nav)
        const groups = page.getByRole('button', { name: /^Groups/ })
        if (!(await groups.isVisible())) await nav.getByRole('button', { name: 'More' }).click()
        await groups.click()
        await page.getByLabel('Loading people').waitFor()
        await stable(page, nav, before, async () => {})
        assert.equal(
          await page.locator('[data-selection-id]').count(),
          0,
          'Previous category must not display as the next category',
        )
        finish()
        await page.locator('[data-selection-id]').first().waitFor()
        await stable(page, nav, before, async () => {})
        await page.goBack()
        await page.getByText('No people in this category.', { exact: true }).waitFor()
        assert.equal(new URL(page.url()).search, '', 'Back must return to previous People view')
      },
    )
  }

  for (const kind of ['person', 'unknown', 'review', 'groups']) {
    await scenario(
      `${kind} failed partial write reconciles selection without replay`,
      async (page) => {
        await page.setViewportSize({ width: 390, height: 900 })
        const data = person()
        let visibleFaces = faces.slice(0, 3)
        let visibleGroups = overview.unnamed.slice(0, 3)
        let writes = 0
        await page.route(/\/api\/people(?:\/|\?|$)/, (route) => {
          const url = new URL(route.request().url())
          if (route.request().method() === 'POST') {
            writes++
            if (writes === 1) {
              // One selected face/group committed before the response was lost.
              visibleFaces = visibleFaces.slice(1)
              visibleGroups = visibleGroups.slice(1)
              return route.abort('failed')
            }
            return json(route, { ok: true })
          }
          if (url.pathname.endsWith('/settings'))
            return json(route, { enabled: true, shareNames: true })
          if (url.pathname.endsWith('/unknown') || url.pathname.endsWith('/review'))
            return json(route, { faces: visibleFaces, more: false })
          if (url.pathname === '/api/people/' + data.person.personId)
            return json(route, { ...data, faces: visibleFaces })
          return json(route, { ...overview, unnamed: visibleGroups })
        })
        const path =
          kind === 'person'
            ? '/people/' + data.person.personId
            : kind === 'groups'
              ? '/people?filter=unnamed'
              : '/people?tab=' + kind
        await page.goto(origin + path)
        await style(page)
        const tiles = page.locator('[data-selection-id]')
        await tiles.first().waitFor()
        const firstId = await tiles.nth(0).getAttribute('data-selection-id')
        const secondId = await tiles.nth(1).getAttribute('data-selection-id')
        await tiles.nth(0).locator('label').click()
        await tiles.nth(1).locator('label').click()
        const dock = page.getByRole('region', {
          name: kind === 'groups' ? 'Selected groups' : 'Selected faces',
          exact: true,
        })
        await openActions(dock)
        const action = dock.getByRole('button', {
          name: kind === 'groups' ? 'Ignore groups' : 'Ignore faces',
          exact: true,
        })
        await action.click()
        await page.getByRole('alert').waitFor()
        assert.equal(writes, 1, 'Reconciliation must not replay an uncertain mutation')
        assert.equal(
          await page.locator(`[data-selection-id="${firstId}"]`).count(),
          0,
          'Committed removal must disappear',
        )
        assert.equal(
          await page.locator(`[data-selection-id="${secondId}"]`).getByRole('checkbox').isChecked(),
          true,
          'Unaffected selected item must remain selected',
        )
        await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
        await openActions(dock)
        await action.click()
        await page.waitForFunction(
          () => document.querySelectorAll('input[type="checkbox"]:checked').length === 0,
        )
        assert.equal(writes, 2, 'Only explicit user retry may write again')
      },
    )
  }
}
