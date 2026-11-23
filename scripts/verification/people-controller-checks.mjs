import assert from 'node:assert/strict'

const id = '11111111-1111-4111-8111-111111111111'
const person = (personId = id, name = 'Alice') => ({
  personId,
  name,
  hidden: false,
  coverFaceId: null,
  photoCount: 1,
  reviewCount: 0,
})
const detail = () => ({
  person: person(),
  faces: [{ faceId: 1, photoId: 1, hasCrop: false, status: 'confirmed' }],
  more: false,
  nextCursor: null,
})

export async function peopleControllerChecks({ scenario, origin, json, settled }) {
  await scenario(
    'People controller preserves menu draft and keyboard focus across selection',
    async (page) => {
      await page.route('**/api/people/' + id, (route) => json(route, detail()))
      await page.goto(origin + '/people/' + id)
      await page.locator('style').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
      await page.addStyleTag({ url: origin + '/layout.css' })
      await settled(page)
      const trigger = page.getByRole('button', { name: 'Person actions', exact: true })
      await trigger.click()
      await page.getByRole('button', { name: 'Edit name', exact: true }).click()
      const input = page.getByRole('textbox', { name: 'Name', exact: true })
      await input.fill('Unsubmitted name')
      await page.locator('[data-selection-id="1"] label').click()
      assert.equal(
        await page.getByRole('checkbox', { name: 'Select face 1', exact: true }).isChecked(),
        true,
      )
      await page.getByRole('button', { name: 'Done selecting', exact: true }).click()
      await trigger.click()
      await page.getByRole('button', { name: 'Edit name', exact: true }).click()
      assert.equal(await input.inputValue(), 'Unsubmitted name')
      await input.press('Escape')
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
      assert.equal(await trigger.evaluate((node) => document.activeElement === node), true)
      await trigger.click()
      await page.getByRole('button', { name: 'Edit name', exact: true }).click()
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.getByRole('button', { name: 'Edit name', exact: true }).click()
      assert.equal(await input.inputValue(), 'Alice')
    },
  )

  await scenario(
    'People controller Undo targets its correction and reconciles a lost response once',
    async (page) => {
      const data = detail()
      const writes = []
      let reads = 0
      await page.route(/\/api\/people\//, (route) => {
        const request = route.request()
        if (request.method() === 'GET') {
          reads++
          return json(route, data)
        }
        writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() })
        if (request.method() === 'PATCH') {
          data.person.name = request.postDataJSON().name
          return json(route, { correctionId: 42 })
        }
        assert.equal(new URL(request.url()).pathname, '/api/people/undo')
        data.person.name = 'Alice'
        return route.abort('failed')
      })
      await page.goto(origin + '/people/' + id)
      await page.getByRole('button', { name: 'Person actions', exact: true }).click()
      await page.getByRole('button', { name: 'Edit name', exact: true }).click()
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Updated Alice')
      await page.getByRole('button', { name: 'Save name', exact: true }).click()
      await page.getByRole('heading', { name: 'Updated Alice', exact: true }).waitFor()
      const beforeUndo = reads
      await page.getByRole('button', { name: 'Undo', exact: true }).click()
      await page.getByRole('heading', { name: 'Alice', exact: true }).waitFor()
      await settled(page)
      assert.deepEqual(writes, [
        { path: '/api/people/' + id, body: { name: 'Updated Alice' } },
        { path: '/api/people/undo', body: { id: 42 } },
      ])
      assert.equal(reads, beforeUndo + 1, 'Uncertain Undo reads current state without replay')
    },
  )

  await scenario(
    'People controller pages retain identity order and refresh repeated people',
    async (page) => {
      const second = '22222222-2222-4222-8222-222222222222'
      const third = '33333333-3333-4333-8333-333333333333'
      await page.route('**/api/people/settings', (route) =>
        json(route, { enabled: true, shareNames: false }),
      )
      await page.route('**/api/people?*', (route) => {
        const cursor = new URL(route.request().url()).searchParams.get('cursor')
        return json(route, {
          named: cursor
            ? [person(id, 'Updated Alice'), person(third, 'Bob')]
            : [person(), person(second, 'Bob')],
          unnamed: [],
          hidden: [],
          nextCursor: cursor ? null : 'second-page',
          more: !cursor,
          reviewCount: 0,
          lowerConfidenceCount: 0,
          unknownCount: 0,
          ignoredCount: 0,
          unnamedCount: 0,
          peopleCount: 3,
        })
      })
      await page.goto(origin + '/people')
      await page.getByRole('button', { name: 'Load more people', exact: true }).click()
      await page.getByText('Updated Alice', { exact: true }).waitFor()
      const cards = page.getByRole('region', { name: 'Named', exact: true }).locator('a')
      assert.deepEqual(
        await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
        ['/people/' + id, '/people/' + second, '/people/' + third],
      )
      assert.equal(
        await cards.filter({ hasText: 'Bob' }).count(),
        2,
        'Equal names remain distinct identities',
      )
      assert.equal(
        await page.getByRole('button', { name: 'Load more people', exact: true }).count(),
        0,
      )
    },
  )
}
