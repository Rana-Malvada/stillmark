import { ClientResponseError, readClientResponse } from './client-response'

/** Bounds headers AND body consumption. Never retries a mutation automatically. */
export async function clientOperation<T>(
  url: string,
  init: RequestInit,
  fallback: string,
  validate?: (value: unknown) => value is T,
  timeoutMs = 45_000,
): Promise<T> {
  const controller = new AbortController()
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('The request timed out. Please try again.'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, signal })
        const data = await readClientResponse(response, fallback, validate)
        signal.throwIfAborted()
        return data
      })(),
      expired,
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class UnconfirmedMutationError extends Error {
  constructor() {
    super(
      'The result could not be confirmed. Check the current data before trying again; the change may already have been saved.',
    )
    this.name = 'UnconfirmedMutationError'
  }
}

/** A dropped response is not proof that the server rolled back. Re-read, never replay. */
export async function clientMutation<T>(
  url: string,
  init: RequestInit,
  fallback: string,
  validate?: (value: unknown) => value is T,
  reconcile?: () => void | Promise<unknown>,
  timeoutMs = 45_000,
): Promise<T> {
  try {
    return await clientOperation(url, init, fallback, validate, timeoutMs)
  } catch (error) {
    if (error instanceof ClientResponseError && error.status >= 400 && error.status < 500)
      throw error
    if (init.signal?.aborted) throw error
    try {
      await reconcile?.()
    } catch {
      /* Keep the uncertain-write message if its read also fails. */
    }
    throw new UnconfirmedMutationError()
  }
}
