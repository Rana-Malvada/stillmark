/** Preserve HTTP outcomes without exposing an upstream HTML response to the UI. */
export class ClientResponseError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message)
    this.name = 'ClientResponseError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function readClientResponse<T>(
  response: Response,
  fallback: string,
  validate?: (value: unknown) => value is T,
): Promise<T> {
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new ClientResponseError(fallback, response.status)
  }
  if (!response.ok) {
    const message = record(data) && typeof data.error === 'string' ? data.error.trim() : ''
    const code =
      record(data) && typeof data.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(data.code)
        ? data.code
        : undefined
    throw new ClientResponseError(
      message && message.length <= 1000 && !/[<>\x00-\x1f]/.test(message) ? message : fallback,
      response.status,
      code,
    )
  }
  if (!(validate ? validate(data) : record(data)))
    throw new ClientResponseError(fallback, response.status)
  return data as T
}
