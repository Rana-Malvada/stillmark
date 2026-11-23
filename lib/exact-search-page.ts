import { HttpError } from './http'

export type ExactPosition = { date: string | null; id: number }
export type ExactWindow = {
  limit: number
  after?: ExactPosition
  only?: boolean
  used?: boolean
  next?: ExactPosition | null
  more?: boolean
  ids?: number[]
}
export function exactSearchCursor(session: string, position: ExactPosition, seen: number) {
  return 'x:' + Buffer.from(JSON.stringify({ session, position, seen })).toString('base64url')
}
export function readExactSearchCursor(value: string) {
  try {
    if (value.length > 2048 || !/^x:[a-zA-Z0-9_-]+$/.test(value)) throw Error()
    const result = JSON.parse(Buffer.from(value.slice(2), 'base64url').toString('utf8'))
    const { session, position, seen } = result
    if (
      typeof session !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(session) ||
      !position ||
      !Number.isSafeInteger(position.id) ||
      position.id < 1 ||
      !(
        position.date === null ||
        (typeof position.date === 'string' &&
          position.date.length < 80 &&
          /^\d{4}-\d{2}-\d{2}/.test(position.date) &&
          Number.isFinite(Date.parse(position.date)))
      ) ||
      !Number.isSafeInteger(seen) ||
      seen < 1
    )
      throw Error()
    return result as { session: string; position: ExactPosition; seen: number }
  } catch {
    throw new HttpError(400, 'Invalid search cursor')
  }
}
