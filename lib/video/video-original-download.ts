import { open } from 'node:fs/promises'
import { getPresignedUrl } from '../media/image-urls'
import { VideoPreparationError } from './video-preparation-error'

type DownloadOptions = {
  timeoutMs: number
  signal?: AbortSignal
  messages: { unreadable: string; changed: string; incomplete: string }
}

/** One streamed copy, bounded by the catalog size. The caller owns temporary-directory cleanup. */
export async function downloadVideoOriginal(
  original: string,
  destination: string,
  expectedBytes: number,
  { timeoutMs, signal, messages }: DownloadOptions,
) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0)
    throw new VideoPreparationError(messages.changed)
  signal?.throwIfAborted()
  const response = await fetch(await getPresignedUrl(original), {
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  })
  const reader = response.body?.getReader()
  let file: Awaited<ReturnType<typeof open>> | undefined
  let bytes = 0
  try {
    if (!response.ok || !reader) throw new VideoPreparationError(messages.unreadable)
    file = await open(destination, 'wx')
    while (true) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      bytes += value.length
      if (bytes > expectedBytes) throw new VideoPreparationError(messages.changed)
      await file.writeFile(value)
    }
    if (bytes !== expectedBytes) throw new VideoPreparationError(messages.incomplete)
  } finally {
    // Includes failed HTTP responses and a failed exclusive file open. Neither
    // may leave the original download consuming a connection in the background.
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
    await file?.close()
  }
}
