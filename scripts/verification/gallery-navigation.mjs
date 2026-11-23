import assert from 'node:assert/strict'

export async function galleryNavigationChecks({ scenario, origin, json, settled }) {
  for (const width of [390, 1280])
    await scenario(
      `Gallery navigation preserves filters and return position at ${width}px`,
      async (page) => {
        await page.setViewportSize({ width, height: 720 })
        await page.route('**/api/events/7?*', (route) =>
          json(route, {
            items: Array.from({ length: 90 }, (_, i) => ({
              photoId: i + 1,
              eventId: 7,
              sourceFilename: `Photo ${i + 1}`,
              thumbnailUrl: null,
              aspectRatio: 1,
              mediaType: 'photo',
              favorite: true,
            })),
            nextCursor: null,
          }),
        )
        await page.goto(origin + '/events/7?sort=newest&media=photo')
        // Virtual rows are re-keyed when their first measured column count replaces
        // the SSR estimate. Wait for that real geometry, not a fixed sleep or a tile
        // from the provisional rows (which can detach on a slower CI browser).
        await page.waitForFunction(() => {
          const grid = document.querySelector('.photo-grid')
          if (!grid) return false
          const style = getComputedStyle(grid)
          const columns = Number(style.getPropertyValue('--photo-columns')) || 3
          const gap = parseFloat(style.getPropertyValue('--photo-gap')) || 0
          const stride = (grid.getBoundingClientRect().width - (columns - 1) * gap) / columns + gap
          return (
            Math.abs(
              grid.getBoundingClientRect().height - (Math.ceil(90 / columns) * stride - gap),
            ) < 2
          )
        })
        const tile = page.getByRole('button', { name: 'Open Photo 15', exact: true })
        await tile.scrollIntoViewIfNeeded()
        const initialY = await page.evaluate(() => scrollY)
        await tile.click()
        const url = new URL(page.url())
        assert.equal(url.searchParams.get('sort'), 'newest')
        assert.equal(url.searchParams.get('media'), 'photo')
        assert.equal(url.searchParams.get('context'), 'album')
        await page.getByRole('button', { name: 'Return to album', exact: true }).click()
        await tile.waitFor()
        await page.waitForFunction((y) => Math.abs(scrollY - y) < 2, initialY)
        assert.equal(new URL(page.url()).search, '?sort=newest&media=photo')
        await page.getByRole('button', { name: 'Filter & Sort', exact: true }).click()
        assert.equal(await page.locator('select[name="sort"]').inputValue(), 'newest')
        assert.equal(await page.locator('select[name="media"]').inputValue(), 'photo')
        await page.locator('select[name="sort"]').selectOption('name')
        await page.getByRole('button', { name: 'Apply', exact: true }).click()
        assert.equal(new URL(page.url()).searchParams.get('sort'), 'name')
      },
    )
  await scenario('Navigation keyboard focus enters popup and returns predictably', async (page) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route('**/api/favorites?*', (r) => json(r, { items: [], nextCursor: null }))
    await page.goto(origin + '/favorites?fixtureHeader=1')
    await page.locator('style').evaluateAll((styles) => styles.forEach((s) => s.remove()))
    await page.addStyleTag({ url: origin + '/layout.css' })
    await settled(page)
    const trigger = page.getByRole('button', { name: 'Navigation', exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const popup = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`)
    const first = popup.locator('a,button').first()
    await first.waitFor()
    assert.equal(await first.evaluate((el) => document.activeElement === el), true)
    await page.keyboard.press('Shift+Tab')
    assert.equal(await trigger.evaluate((el) => document.activeElement === el), true)
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    await page.keyboard.press('ArrowDown')
    await first.waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await trigger.evaluate((el) => document.activeElement === el), true)
    await page.keyboard.press('Enter')
    const last = popup.locator('a,button').last()
    await last.focus()
    await page.keyboard.press('Tab')
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(
      await page
        .getByRole('button', { name: 'Search library', exact: true })
        .evaluate((el) => document.activeElement === el),
      true,
    )
  })
}
