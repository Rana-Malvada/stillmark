// Public-link transport only: every request remains under the share token route.
// The server rechecks expiry/revocation. Client validation never grants access.
export async function sharedRequest(url, init, consume, timeoutMs = 30_000, fetcher = fetch) {
  const controller = new AbortController()
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
  let timer
  let abort
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(
      () => controller.abort(new Error('The request timed out. Please retry.')),
      timeoutMs,
    )
  })
  try {
    signal.throwIfAborted()
    return await Promise.race([
      interrupted,
      (async () => {
        const response = await fetcher(url, { ...init, signal })
        if (!response.ok) throw new Error('This sharing link is unavailable or has expired.')
        const result = await consume(response)
        signal.throwIfAborted()
        return result
      })(),
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    controller.abort()
  }
}
export function sharedJson(url, init, validate, timeoutMs, fetcher) {
  return sharedRequest(
    url,
    init,
    async (response) => {
      const data = await response.json()
      if (!validate(data)) throw new Error('The server returned invalid shared-album data.')
      return data
    },
    timeoutMs,
    fetcher,
  )
}
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export const isSharedPage = (value) =>
  record(value) &&
  Array.isArray(value.items) &&
  value.items.length <= 60 &&
  value.items.every(
    (photo) =>
      record(photo) &&
      Number.isSafeInteger(photo.photo_id) &&
      photo.photo_id > 0 &&
      typeof photo.source_filename === 'string' &&
      ['photo', 'video'].includes(photo.media_type),
  ) &&
  (value.nextPage === null || (Number.isSafeInteger(value.nextPage) && value.nextPage >= 0))
export const isSharedDetails = (value) =>
  record(value) &&
  record(value.details) &&
  Object.values(value.details).every(
    (item) =>
      item === null ||
      ['string', 'boolean'].includes(typeof item) ||
      (typeof item === 'number' && Number.isFinite(item)),
  ) &&
  Array.isArray(value.people) &&
  value.people.every(
    (person) =>
      record(person) &&
      typeof person.name === 'string' &&
      (person.box === null ||
        (record(person.box) &&
          ['x', 'y', 'w', 'h'].every(
            (key) =>
              typeof person.box[key] === 'number' &&
              Number.isFinite(person.box[key]) &&
              person.box[key] >= 0 &&
              person.box[key] <= 1,
          ))),
  )
