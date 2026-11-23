import assert from 'node:assert/strict'
/** This tests the web handoff, NOT iOS's native Photos preparation or iCloud download. */
export async function uploadPickerChecks({ scenario, origin }) {
  for (const count of [35, 100])
    await scenario(
      `Upload picker handoff: ${count} original files queued once in selection order`,
      async (page) => {
        await page.goto(origin + '/fixture/add-photos')
        const input = page.locator('input[type=file][accept]')
        assert.equal(await input.getAttribute('accept'), 'image/*,video/*')
        const files = Array.from({ length: count }, (_, i) => {
          const [extension, mimeType] = [
            ['HEIC', 'image/heic'],
            ['JPG', 'image/jpeg'],
            ['MOV', 'video/quicktime'],
          ][i % 3]
          return {
            name: `IMG_${i}.${extension}`,
            mimeType,
            buffer: Buffer.from(`original fixture ${i}`),
          }
        })
        // Nothing starts while the browser has not delivered a change event.
        assert.equal(await page.evaluate(() => window.fixtureUploads?.length ?? 0), 0)
        await input.setInputFiles(files)
        await page.waitForFunction(() => window.fixtureUploads?.length === 1)
        const [queued] = await page.evaluate(() => window.fixtureUploads)
        assert.deepEqual(
          queued.files.map(({ name, size, type }) => ({ name, size, type })),
          files.map((f) => ({ name: f.name, size: f.buffer.length, type: f.mimeType })),
        )
        assert.equal(queued.fields.eventId, 7)
        assert.equal(await input.inputValue(), '')
        assert.equal(await input.count(), 1)
      },
    )
}
