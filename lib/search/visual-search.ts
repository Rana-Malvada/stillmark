import type { SearchEligibility } from './search-eligibility'
import { visualSearchQuery } from './visual-search-query'
import { searchModelAssets } from './search-model-assets'
import { pgQuery } from '../postgres'
import { flagOn } from '../flags'

// The image worker uses the matching OpenAI CLIP ViT-B/32 weights. Activation
// requires a measured compatibility/latency check and local, pinned ONNX assets.
let encoder:
  | Promise<{
      tokenizer: import('@huggingface/transformers').PreTrainedTokenizer
      model: import('@huggingface/transformers').CLIPTextModelWithProjection
    }>
  | undefined
let retryAfter = 0
let ready = false
let busy = false
async function embedding(query: string): Promise<number[]> {
  encoder ??= (async () => {
    const { env, AutoTokenizer, CLIPTextModelWithProjection } =
      await import('@huggingface/transformers')
    env.allowRemoteModels = false
    const path = await searchModelAssets()
    const tokenizer = await AutoTokenizer.from_pretrained(path, { local_files_only: true })
    const model = await CLIPTextModelWithProjection.from_pretrained(path, {
      local_files_only: true,
      dtype: 'fp32',
      device: 'cpu',
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    })
    ready = true
    return { tokenizer, model }
  })()
  const { tokenizer, model } = await encoder
  const { text_embeds } = await model(
    tokenizer(query, { padding: true, truncation: true, max_length: 77 }),
  )
  const values = Array.from(text_embeds.data as Float32Array)
  const norm = Math.hypot(...values)
  if (values.length !== 512 || !norm || !values.every(Number.isFinite))
    throw new Error('Invalid visual query embedding')
  return values.map((v) => v / norm)
}
export async function visualMatches(
  query: string,
  allowedIds: number[],
  eligibleIds?: number[],
  limit = 1000,
  eligibility?: SearchEligibility,
): Promise<number[]> {
  if (!flagOn('SEARCH_VISUAL_ENABLED')) return []
  if (!ready) {
    if (!encoder && Date.now() > retryAfter)
      void embedding('a photo').catch(() => {
        encoder = undefined
        ready = false
        retryAfter = Date.now() + 60000
        console.warn('[visual-search] Model warmup unavailable')
      })
    return []
  }
  if (busy) return []
  busy = true
  let vector: number[]
  try {
    vector = await embedding(query)
  } finally {
    busy = false
  }
  const statement = visualSearchQuery(vector, allowedIds, eligibleIds, limit, eligibility)
  const rows = await pgQuery<{ photoId: number }>(statement.sql, statement.params)
  return rows.map((r) => r.photoId)
}
