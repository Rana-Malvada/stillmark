import { HttpError } from '../http'
import { photoAiRetryAfter } from '../photos/photo-ai-retry'
import type { InferenceHooks } from '../photos/photo-inference-recovery'
import sharp from 'sharp'
import { beginRestCost, finishRestCost } from './cortex-rest-costs'
import { deployment } from '../../config/deployment.mjs'
import { getServiceToken } from '../snowflake'
import { getPresignedUrl } from '../media/image-urls'
import { storageByteCache } from './storage-byte-cache'

const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const IMAGE_PREPARATION_CONCURRENCY = 3
let preparingImages = 0
const preparationWaiters: Array<() => void> = []

/** Keep downloads/resizing bounded independently of requests waiting on the provider.
 * Shared by every provider so the three-slot limit holds across them. */
export async function prepareImage(path: string) {
  if (preparingImages < IMAGE_PREPARATION_CONCURRENCY) preparingImages++
  else await new Promise<void>((resolve) => preparationWaiters.push(resolve))
  try {
    return await imageBytes(path)
  } finally {
    const next = preparationWaiters.shift()
    if (next) next()
    else preparingImages--
  }
}

/** Download only our display image, never pass stage credentials or URLs to the model. */
async function imageBytes(path: string) {
  if (
    !path.startsWith('display/') ||
    path.length > 1024 ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw Error('Photo AI requires a display image')
  const prepared = storageByteCache.get(`ai:${path}`)
  if (prepared) return prepared
  const local = storageByteCache.take(`display:${path}`)
  const input = local ?? (await downloadImage(path))
  const image = await sharp(input, { limitInputPixels: 80_000_000 })
    .rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer()
  if (image.length > 5 * 1024 * 1024) throw Error('Photo exceeds Cortex image size limit')
  storageByteCache.set(`ai:${path}`, image, 15 * 60_000)
  return image
}
async function downloadImage(path: string) {
  const url = new URL(await getPresignedUrl(path, 300))
  // Snowflake containers receive account-specific S3 access-point URLs.
  // Keep both verified hosts explicit; never allow arbitrary S3 destinations.
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    ![deployment.STORAGE_HOST, deployment.RUNTIME_STORAGE_HOST].includes(url.hostname)
  )
    throw Error('Unexpected photo storage host')
  const response = await fetch(url, {
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok || !response.body) throw Error('Unable to read photo for AI description')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_IMAGE_BYTES) throw Error('Photo exceeds AI input size limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/** Inference uses Cortex REST, with no SQL inference fallback or warehouse selection. */
export async function describePhoto(
  path: string,
  model: string,
  prompt: string,
  hooks?: InferenceHooks,
): Promise<string> {
  // Read fresh for every request so rotating runtime credentials remain valid.
  const serviceToken = getServiceToken()
  const token = serviceToken || process.env.SNOWFLAKE_CORTEX_TOKEN
  if (!token) throw Error('Cortex REST authentication is unavailable')
  // The container's injected host is reachable through Snowflake's runtime network.
  // The public organization/account alias may not resolve inside that network.
  const origin =
    serviceToken && process.env.SNOWFLAKE_HOST
      ? `https://${process.env.SNOWFLAKE_HOST}`
      : deployment.SNOWFLAKE_API_ORIGIN
  const image = await prepareImage(path)
  const costId = await beginRestCost(model)
  await hooks?.dispatched(costId)
  const response = await fetch(`${origin}/api/v2/cortex/v1/messages`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(serviceToken ? { 'X-Snowflake-Authorization-Token-Type': 'OAUTH' } : {}),
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      Accept: 'application/json',
      'User-Agent': 'personal-photos/1.0',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  })
  // Never persist raw provider errors: they may echo image data or authentication details.
  if (!response.ok) {
    if (response.status === 429) {
      await hooks?.rateLimited()
      throw new HttpError(
        429,
        'Cortex photo description failed (HTTP 429)',
        photoAiRetryAfter(response.headers.get('retry-after')),
      )
    }
    throw Error(`Cortex photo description failed (HTTP ${response.status})`)
  }
  const result = await response.json()
  if (result.stop_reason !== 'end_turn')
    throw Error('Cortex returned an incomplete photo description')
  const text = Array.isArray(result.content)
    ? result.content
        .filter(
          (b: { type?: string; text?: unknown }) => b.type === 'text' && typeof b.text === 'string',
        )
        .map((b: { text: string }) => b.text)
        .join('')
    : ''
  if (!text.trim()) throw Error('Cortex returned no photo description')
  const receipt = {
    text,
    costId,
    model,
    usage: result.usage,
    requestId:
      response.headers.get('x-snowflake-request-id') ||
      response.headers.get('request-id') ||
      result.request_id ||
      result.id,
  }
  await hooks?.received(receipt)
  try {
    await finishRestCost(costId, model, receipt.usage, receipt.requestId)
  } catch (error) {
    if (!hooks) throw error
    // The private durable receipt allows ledger reconciliation without repeating inference.
    console.warn('[photo-ai-ledger]')
  }
  return text
}
