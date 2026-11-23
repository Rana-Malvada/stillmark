import { clientMutation, clientOperation } from '../client-operation'

/** People reads and writes have a finite lifetime, including response bodies.
 * Writes are never replayed: the owning screen reconciles its current view. */
export async function peopleApi<T = Record<string, unknown>>(
  url: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
  validate?: (value: unknown) => value is T,
): Promise<T> {
  const init: RequestInit = {
    signal,
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  }
  return method === 'GET'
    ? clientOperation(url, init, 'Unable to load people. Please retry.', validate)
    : clientMutation(url, init, 'Unable to update people. Please retry.', validate)
}
