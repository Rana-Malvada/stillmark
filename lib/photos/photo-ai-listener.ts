import type pg from 'pg'

// The coordinator renews every ten seconds. A failed connection is retried
// at its next renewal. A separate minute timer also recovers due retries.
export function createPhotoAiListener(createClient: () => pg.Client, drain: () => Promise<void>) {
  let client: pg.Client | undefined

  function disconnect(current: pg.Client) {
    if (current !== client) return
    client = undefined
    void current.end().catch(() => {})
  }

  function wake(current: pg.Client) {
    if (current === client) void drain().catch((error) => console.error('[photo-ai]', error))
  }

  return async function syncLeader(leader: boolean) {
    if (!leader) {
      if (client) disconnect(client)
      return
    }
    if (client) return
    const current = createClient()
    client = current
    current.on('error', (error) => {
      console.error('[photo-ai-listener]', error.message)
      disconnect(current)
    })
    current.on('end', () => disconnect(current))
    current.on('notification', ({ channel }) => {
      if (channel === 'stillmark_photo_ai_ready') wake(current)
    })
    try {
      await current.connect()
      if (current !== client) return
      await current.query('LISTEN stillmark_photo_ai_ready')
      // LISTEN is committed before inspecting the queue, closing the startup gap.
      wake(current)
    } catch (error) {
      disconnect(current)
      throw error
    }
  }
}
