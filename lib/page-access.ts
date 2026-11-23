import { notFound } from 'next/navigation'
import { HttpError } from './http'

/** Page-only adapter: API guards retain their original 401/403 responses. */
export async function authorizePage<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check()
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) notFound()
    throw error
  }
}
