import { HttpError } from '../http'

type Value = string | number | boolean | null
/** Cursor positions are not capabilities. Every page still applies current RLS.
 * Bind the position to its list/filter so it cannot silently change semantics. */
export function readFaceCursor(
  value: unknown,
  key: string,
  valid: (v: Value[]) => boolean,
): Value[] | null {
  if (value == null || value === '') return null
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[a-zA-Z0-9_-]+$/.test(value))
      throw Error()
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (decoded.v !== 1 || decoded.k !== key || !Array.isArray(decoded.a) || !valid(decoded.a))
      throw Error()
    return decoded.a
  } catch {
    throw new HttpError(400, 'Invalid face page cursor')
  }
}
export const cursorId = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0
export const cursorNumber = (v: unknown) =>
  v === null || (typeof v === 'number' && Number.isFinite(v))
export const cursorDate = (v: unknown) =>
  v === null ||
  (typeof v === 'string' &&
    v.length < 80 &&
    /^\d{4}-\d{2}-\d{2}/.test(v) &&
    Number.isFinite(Date.parse(v)))
export function facePage<T extends { _cursor: Value[] }>(rows: T[], key: string) {
  const page = rows.slice(0, 200)
  return {
    faces: page.map(({ _cursor: _, ...face }) => face),
    more: rows.length > 200,
    nextCursor:
      rows.length > 200 && page.length
        ? Buffer.from(JSON.stringify({ v: 1, k: key, a: page.at(-1)!._cursor })).toString(
            'base64url',
          )
        : null,
  }
}
