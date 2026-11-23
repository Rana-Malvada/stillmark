import { HttpError } from '../http'
import { photoAiRetryAfter } from '../photos/photo-ai-retry'
import type { InferenceHooks } from '../photos/photo-inference-recovery'
import { prepareImage } from '../snowflake/cortex-photo'
import {
  beginRestCost,
  finishRestCost,
  OPENAI_PRICING_VERSION,
} from '../snowflake/cortex-rest-costs'
import { getSecret, SecretType } from '../snowflake/secrets'

/** The provider refused before doing any work: no key, a rejected key, no credit left,
 * or a request it would not accept. Nothing was charged, so the caller may describe the
 * photo through another provider. `pause` is false when only this request was refused. */
export class PhotoAiProviderUnavailable extends Error {
  constructor(
    message: string,
    public pause = true,
  ) {
    super(message)
  }
}

// Fixed destination. The key is sent nowhere else and redirects are refused.
const ENDPOINT = 'https://api.openai.com/v1/responses'
// Refusals that mean "this account cannot pay", as opposed to "slow down".
const NO_CREDIT = [
  'credit_balance_exhausted',
  'insufficient_quota',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]
const SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['description', 'tags'],
  additionalProperties: false,
}

function apiKey() {
  try {
    const key = getSecret('OPENAI_API', SecretType.GENERIC_STRING)
    if (key) return key
  } catch {
    // Not mounted: handled below without echoing the secret reader's message.
  }
  throw new PhotoAiProviderUnavailable('OpenAI authentication is unavailable')
}

/** Only the short machine code is read from an error body; the body is never kept. */
async function errorCode(response: Response) {
  try {
    const body = await response.json()
    const code = body?.error?.code ?? body?.error?.type
    return typeof code === 'string' ? code.slice(0, 64) : ''
  } catch {
    return ''
  }
}

/** Describe one display image with OpenAI's Responses API. Same contract as the Cortex
 * transport: returns the raw JSON text and records a durable receipt through the hooks. */
export async function describePhotoOpenAI(
  path: string,
  model: string,
  prompt: string,
  hooks?: InferenceHooks,
): Promise<string> {
  const key = apiKey()
  const image = await prepareImage(path)
  const costId = await beginRestCost(model, OPENAI_PRICING_VERSION)
  await hooks?.dispatched(costId)
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'personal-photos/1.0',
    },
    body: JSON.stringify({
      model,
      // Do not keep the photo or the description on the provider's side for later retrieval.
      store: false,
      // Reasoning counts toward this limit, so it is well above the description's size.
      max_output_tokens: 4096,
      reasoning: { effort: 'low' },
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: `data:image/jpeg;base64,${image.toString('base64')}`,
              detail: 'high',
            },
            { type: 'input_text', text: prompt },
          ],
        },
      ],
      text: {
        format: { type: 'json_schema', name: 'photo_description', strict: true, schema: SCHEMA },
      },
    }),
  })
  // Never persist raw provider errors: they may echo image data or authentication details.
  if (!response.ok) {
    const code = await errorCode(response)
    const unpaid = response.status === 429 && NO_CREDIT.includes(code)
    if (unpaid || response.status === 401 || response.status === 403) {
      // Rejected before any work: release the receipt so another provider can take the photo.
      await hooks?.rateLimited()
      throw new PhotoAiProviderUnavailable(
        unpaid
          ? 'OpenAI credit is used up'
          : `OpenAI rejected the request (HTTP ${response.status})`,
      )
    }
    if ([400, 404, 422].includes(response.status)) {
      // The request itself was not accepted (this image, or a retired model name).
      // No work was done; describe this photo elsewhere without pausing the provider.
      await hooks?.rateLimited()
      throw new PhotoAiProviderUnavailable(
        `OpenAI did not accept the request (HTTP ${response.status})`,
        false,
      )
    }
    if (response.status === 429) {
      await hooks?.rateLimited()
      throw new HttpError(
        429,
        'OpenAI photo description failed (HTTP 429)',
        photoAiRetryAfter(response.headers.get('retry-after')),
      )
    }
    throw Error(`OpenAI photo description failed (HTTP ${response.status})`)
  }
  const result = await response.json()
  if (result.status !== 'completed') throw Error('OpenAI returned an incomplete photo description')
  const parts: Array<{ type?: string; text?: unknown }> = Array.isArray(result.output)
    ? result.output
        .filter((item: { type?: string }) => item?.type === 'message')
        .flatMap((item: { content?: unknown }) => (Array.isArray(item.content) ? item.content : []))
    : []
  if (parts.some((part) => part?.type === 'refusal'))
    throw Error('OpenAI declined to describe this photo')
  const text = parts
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
  if (!text.trim()) throw Error('OpenAI returned no photo description')
  const receipt = {
    text,
    costId,
    model,
    usage: result.usage,
    requestId: response.headers.get('x-request-id') || result.id,
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
