import assert from 'node:assert/strict'

const waitFor = async (predicate) => {
  const until = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < until, 'Expected request was not received')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const photo = (photoId) => ({
  photoId,
  eventId: 7,
  sourceFilename: `Photo ${photoId}.jpg`,
  canEdit: true,
  favorite: false,
  isAlbumCover: false,
  mediaType: 'photo',
  prev: photoId > 1 ? photoId - 1 : null,
  next: photoId < 3 ? photoId + 1 : null,
  displayUrl: null,
  originalUrl: null,
  userTags: [],
})
export async function galleryMaintainabilityChecks({ scenario, origin, json, settled }) {
  for (const mutation of ['favorite', 'cover'])
    await scenario(
      `Gallery write ownership: delayed ${mutation} cannot change next photo`,
      async (page) => {
        let held
        await page.route('**/api/photos/*/people', (r) =>
          json(r, { canEdit: true, faces: [], ignoredFaces: [] }),
        )
        await page.route('**/api/photos/**', (r) => {
          const url = new URL(r.request().url())
          if (url.pathname.endsWith('/people'))
            return json(r, { canEdit: true, faces: [], ignoredFaces: [] })
          if (r.request().method() !== 'GET') {
            held = r
            return
          }
          return json(r, photo(Number(url.pathname.split('/')[3])))
        })
        await page.goto(origin + '/photos/1?fixtureViewer=1')
        await page.locator('style').evaluateAll((styles) => styles.forEach((s) => s.remove()))
        await page.addStyleTag({ url: origin + '/layout.css' })
        await settled(page)
        await page.getByRole('button', { name: 'Add to favorites', exact: true }).waitFor()
        if (mutation === 'favorite')
          await page.getByRole('button', { name: 'Add to favorites', exact: true }).click()
        else {
          await page.getByRole('button', { name: 'More actions', exact: true }).click()
          await page.getByRole('button', { name: 'Set as album cover', exact: true }).click()
        }
        await waitFor(() => held)
        await page.getByRole('button', { name: 'Next photo', exact: true }).click()
        await page.waitForURL('**/photos/2?*')
        await page.getByRole('button', { name: 'Add to favorites', exact: true }).waitFor()
        await json(held, mutation === 'favorite' ? { favorite: true } : { ok: true })
        await settled(page)
        assert.equal(
          await page.getByRole('button', { name: 'Add to favorites', exact: true }).count(),
          1,
        )
        await page.getByRole('button', { name: 'More actions', exact: true }).click()
        assert.equal(
          await page.getByRole('button', { name: 'Set as album cover', exact: true }).isEnabled(),
          true,
        )
        assert.equal(
          await page.getByRole('button', { name: 'Album cover selected', exact: true }).count(),
          0,
        )
      },
    )
  await scenario(
    'Gallery response boundary: invalid photo date is a load error, not a render crash',
    async (page) => {
      await page.route('**/api/photos/1?*', (r) => json(r, { ...photo(1), dateTaken: 'invalid' }))
      await page.goto(origin + '/photos/1?fixtureViewer=1')
      await page.getByText('Unable to load photo', { exact: true }).waitFor()
    },
  )
  await scenario(
    'Gallery response boundary: invalid album groups do not crash collection',
    async (page) => {
      await page.route('**/api/events?*', (r) => json(r, { items: [], groups: { invalid: true } }))
      await page.route('**/api/folders', (r) => json(r, []))
      await page.goto(origin + '/')
      await page
        .getByText('Unable to load albums. Please refresh to retry.', { exact: true })
        .waitFor()
    },
  )
  await scenario(
    'Gallery slideshow rejects malformed continuation without losing current media',
    async (page) => {
      const media = {
        photoId: 1,
        sourceFilename: 'First photo.jpg',
        mediaType: 'photo',
        displayStagePath: null,
        originalStagePath: null,
      }
      await page.route('**/api/events/7?*', (r) =>
        json(
          r,
          new URL(r.request().url()).searchParams.has('cursor')
            ? { items: null, nextCursor: null }
            : { items: [media], nextCursor: 'next' },
        ),
      )
      await page.goto(origin + '/fixture/slideshow/7')
      await page.getByRole('alert').filter({ hasText: 'Unable to load slideshow photos' }).waitFor()
      assert.equal(await page.getByText('First photo.jpg', { exact: true }).count(), 1)
      assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).count(), 1)
    },
  )
  await scenario(
    'Gallery write ownership: bulk completion cannot clear a newer selection',
    async (page) => {
      let held
      await page.route('**/api/events/*?*', (r) => {
        const id = new URL(r.request().url()).pathname.endsWith('/8') ? 2 : 1
        return json(r, {
          items: [
            {
              photoId: id,
              eventId: id === 2 ? 8 : 7,
              sourceFilename: `Grid photo ${id}`,
              thumbnailUrl: null,
              aspectRatio: 1,
              mediaType: 'photo',
              favorite: false,
            },
          ],
          nextCursor: null,
        })
      })
      await page.route('**/api/photos/bulk', (r) => {
        held = r
      })
      await page.goto(origin + '/fixture/gallery-writes')
      await page.locator('style').evaluateAll((styles) => styles.forEach((s) => s.remove()))
      await page.addStyleTag({ url: origin + '/layout.css' })
      await page.getByRole('button', { name: 'Select photos', exact: true }).click()
      await page.locator('.photo-tile').first().click()
      await page.getByRole('button', { name: 'Actions', exact: true }).click()
      await page.getByRole('button', { name: 'Favorite', exact: true }).click()
      await waitFor(() => held)
      await page.getByRole('button', { name: 'Change album', exact: true }).click()
      await page.getByText('Grid photo 2', { exact: true }).waitFor()
      await page.locator('.photo-tile').first().click()
      await json(held, { count: 1 })
      await settled(page)
      assert.equal(
        await page.locator('.photo-tile button').first().getAttribute('aria-pressed'),
        'true',
      )
      assert.equal(await page.getByText('1 files updated', { exact: false }).count(), 0)
    },
  )
}
