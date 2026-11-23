import { expect, it } from 'vitest'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'

const fallback = 'Unable to save folder. Please try again.'
const folderResult = (value: unknown): value is { folderId: number } =>
  value !== null &&
  typeof value === 'object' &&
  'folderId' in value &&
  Number.isSafeInteger(value.folderId) &&
  Number(value.folderId) > 0

it('preserves an HTML proxy failure status without displaying the response body', async () => {
  await expect(
    readClientResponse(new Response('<html>proxy secret</html>', { status: 502 }), fallback),
  ).rejects.toMatchObject({ name: 'ClientResponseError', status: 502, message: fallback })
})

it('keeps safe conflict details and its code so the caller can retain its editor', async () => {
  await expect(
    readClientResponse(
      Response.json(
        { error: 'A folder with that name already exists', code: 'CONFLICT' },
        { status: 409 },
      ),
      fallback,
    ),
  ).rejects.toMatchObject({
    status: 409,
    code: 'CONFLICT',
    message: 'A folder with that name already exists',
  })
})

it.each(['<html>upstream error</html>', 'bad\u0000message', 'x'.repeat(1001)])(
  'does not expose unsafe or oversized error text',
  async (error) => {
    await expect(
      readClientResponse(Response.json({ error, code: '<bad>' }, { status: 502 }), fallback),
    ).rejects.toMatchObject({ status: 502, message: fallback, code: undefined })
  },
)

it('rejects malformed successful JSON with a typed error and the original status', async () => {
  const promise = readClientResponse(new Response('{', { status: 200 }), fallback)
  await expect(promise).rejects.toBeInstanceOf(ClientResponseError)
  await expect(promise).rejects.toMatchObject({ status: 200, message: fallback })
})

it.each([{}, { folderId: '7' }, { folderId: 0 }, { folderId: 1.5 }, null])(
  'does not treat an invalid successful payload as a completed folder mutation',
  async (data) => {
    await expect(
      readClientResponse(Response.json(data), fallback, folderResult),
    ).rejects.toMatchObject({ status: 200, message: fallback })
  },
)

it('returns a validated success without changing the payload', async () => {
  const data = { folderId: 7 }
  expect(await readClientResponse(Response.json(data), fallback, folderResult)).toEqual(data)
})

it('requires an object by default but permits explicitly validated array responses', async () => {
  await expect(readClientResponse(Response.json([]), fallback)).rejects.toBeInstanceOf(
    ClientResponseError,
  )
  expect(
    await readClientResponse(Response.json([]), fallback, (value): value is unknown[] =>
      Array.isArray(value),
    ),
  ).toEqual([])
})
