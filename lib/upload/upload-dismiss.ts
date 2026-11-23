/** A fresh authorized check avoids navigating to deleted or inaccessible albums. */
export async function uploadDismissDestination(eventId?: number): Promise<string | null> {
  if (!Number.isSafeInteger(eventId) || eventId! <= 0) return null
  try {
    const response = await fetch(`/api/events/${eventId}`, {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    return response.status === 200 ? `/events/${eventId}` : null
  } catch {
    return null
  }
}
