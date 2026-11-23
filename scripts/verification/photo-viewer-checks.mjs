import assert from 'node:assert/strict'

const photo = (photoId) => ({
  photoId,
  eventId: 7,
  sourceFilename: `Viewer fixture ${photoId}.jpg`,
  canEdit: true,
  favorite: false,
  isAlbumCover: false,
  mediaType: photoId === 4 ? 'video' : 'photo',
  prev: photoId > 1 ? photoId - 1 : null,
  next: photoId < 4 ? photoId + 1 : null,
  displayUrl: null,
  originalUrl: null,
  userTags: [],
})
const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected viewer request was not received')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function fixture(page, origin, json, id, handle) {
  await page.route('**/api/photos/**', (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/people'))
      return json(route, { canEdit: true, faces: [], ignoredFaces: [] })
    return handle?.(route) ?? json(route, photo(Number(pathname.split('/')[3])))
  })
  await page.goto(`${origin}/photos/${id}?fixtureViewer=1&sort=name`)
  await page.getByRole('button', { name: 'Photo details', exact: true }).waitFor()
}
async function swipe(page, { dx = -100, dy = 0, fingers = 1, interactive = false, zoom = 1 } = {}) {
  await page.evaluate(
    ({ dx, dy, fingers, interactive, zoom }) => {
      const media = document.querySelector('.photo-viewer-media')
      const target = interactive ? media.appendChild(document.createElement('button')) : media
      if (window.visualViewport)
        Object.defineProperty(window.visualViewport, 'scale', { configurable: true, value: zoom })
      const fire = (type, points) => {
        const event = new Event(type, { bubbles: true })
        Object.defineProperties(event, {
          touches: { value: type === 'touchend' ? [] : points },
          changedTouches: { value: points },
        })
        target.dispatchEvent(event)
      }
      fire(
        'touchstart',
        Array.from({ length: fingers }, () => ({ clientX: 200, clientY: 200 })),
      )
      fire('touchend', [{ clientX: 200 + dx, clientY: 200 + dy }])
      if (interactive) target.remove()
      if (window.visualViewport)
        Object.defineProperty(window.visualViewport, 'scale', { configurable: true, value: 1 })
    },
    { dx, dy, fingers, interactive, zoom },
  )
}

export async function photoViewerChecks({ scenario, origin, json, settled }) {
  await scenario(
    'Viewer navigation: details Escape precedence and editable keyboard isolation',
    async (page) => {
      await fixture(page, origin, json, 2)
      await page.keyboard.press('i')
      await page.getByRole('region', { name: 'Photo details', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      assert.equal(
        await page.getByRole('region', { name: 'Photo details', exact: true }).count(),
        0,
      )
      assert.equal(new URL(page.url()).pathname, '/photos/2')
      await page.evaluate(() => {
        const input = document.body.appendChild(document.createElement('input'))
        input.id = 'viewer-keyboard-fixture'
        input.focus()
      })
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('i')
      await page.keyboard.press('Escape')
      await settled(page)
      assert.equal(new URL(page.url()).pathname, '/photos/2')
      assert.equal(
        await page.getByRole('region', { name: 'Photo details', exact: true }).count(),
        0,
      )
      await page.evaluate(() => document.getElementById('viewer-keyboard-fixture').remove())
      const nextPhoto = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/photos/3',
      )
      await page.keyboard.press('ArrowRight')
      await page.waitForURL('**/photos/3?*')
      await nextPhoto
      await settled(page)
      assert.equal(new URL(page.url()).searchParams.get('sort'), 'name')
      const previousPhoto = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/photos/2',
      )
      await page.keyboard.press('ArrowLeft')
      await page.waitForURL('**/photos/2?*')
      await previousPhoto
      await settled(page)
      await page.keyboard.press('Escape')
      await page.waitForURL('**/events/7?*')
      assert.equal(new URL(page.url()).searchParams.get('sort'), 'name')
    },
  )

  await scenario(
    'Viewer navigation: fullscreen fallback stays in place and gates a pending load',
    async (page) => {
      await page.addInitScript(() => {
        Element.prototype.requestFullscreen = async () => {
          throw new Error('Fixture: element fullscreen unavailable')
        }
      })
      let held
      let secondReads = 0
      await fixture(page, origin, json, 1, (route) => {
        if (new URL(route.request().url()).pathname !== '/api/photos/2') return
        secondReads++
        held = route
        return Promise.resolve()
      })
      await page.getByRole('button', { name: 'Enter full screen', exact: true }).click()
      await page.getByRole('button', { name: 'Exit full screen', exact: true }).waitFor()
      await page.keyboard.press('ArrowRight')
      await waitFor(() => held)
      assert.equal(new URL(page.url()).pathname, '/photos/1')
      assert.equal(
        await page.getByRole('button', { name: 'Next photo', exact: true }).isDisabled(),
        true,
      )
      await page.keyboard.press('ArrowRight')
      await settled(page)
      assert.equal(secondReads, 1)
      await json(held, photo(2))
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Previous photo"]').disabled,
      )
      assert.equal(new URL(page.url()).pathname, '/photos/1')
      await page.keyboard.press('Escape')
      await page.waitForURL('**/photos/2?*')
      assert.equal(
        await page.getByRole('button', { name: 'Enter full screen', exact: true }).isVisible(),
        true,
      )
      assert.equal(new URL(page.url()).searchParams.get('sort'), 'name')
    },
  )

  await scenario(
    'Viewer media: swipes preserve zoom, controls and video interaction',
    async (page) => {
      await fixture(page, origin, json, 2)
      for (const gesture of [
        { dx: -20 },
        { dy: 150 },
        { fingers: 2 },
        { interactive: true },
        { zoom: 2 },
      ]) {
        await swipe(page, gesture)
        await settled(page)
        assert.equal(new URL(page.url()).pathname, '/photos/2')
      }
      const nextPhoto = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/photos/3',
      )
      await swipe(page)
      await page.waitForURL('**/photos/3?*')
      await nextPhoto
      await settled(page)
      await page.getByRole('button', { name: 'Next photo', exact: true }).click()
      await page.waitForURL('**/photos/4?*')
      await page.getByText('No video available', { exact: true }).waitFor()
      await swipe(page, { dx: 100 })
      await settled(page)
      assert.equal(new URL(page.url()).pathname, '/photos/4')
    },
  )

  await scenario(
    'Viewer actions: invalid delete acknowledgment keeps the photo until explicit retry',
    async (page) => {
      let deletes = 0
      await fixture(page, origin, json, 2, (route) => {
        if (route.request().method() !== 'DELETE') return
        deletes++
        return json(route, deletes === 1 ? { ok: 'wrong' } : { ok: true })
      })
      await page.getByRole('button', { name: 'Move to trash', exact: true }).click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: 'Unable to delete photo' }).first().waitFor()
      assert.equal(deletes, 1)
      assert.equal(new URL(page.url()).pathname, '/photos/2')
      assert.equal(
        await page.getByRole('button', { name: 'Delete', exact: true }).isEnabled(),
        true,
      )
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await page.waitForURL('**/photos/3?*')
      assert.equal(deletes, 2)
      assert.equal(await page.getByRole('button', { name: 'Delete', exact: true }).count(), 0)
    },
  )
}
