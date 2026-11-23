// Local benchmark; no network, API credentials, or photo data.
import { AutoTokenizer, CLIPTextModelWithProjection, env } from '@huggingface/transformers'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

env.allowRemoteModels = false
const path = resolve('output/search-models')
const start = performance.now()
const tokenizer = await AutoTokenizer.from_pretrained(path, { local_files_only: true })
const model = await CLIPTextModelWithProjection.from_pretrained(path, {
  local_files_only: true,
  dtype: 'fp32',
  device: 'cpu',
  session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
})
const samples = ['a man eating at a restaurant', 'motocross racers with number 6', 'a sunny beach']
const timings = []
const vectors = []
for (const query of samples) {
  const t = performance.now()
  const { text_embeds } = await model(
    tokenizer(query, { padding: true, truncation: true, max_length: 77 }),
  )
  const v = Array.from(text_embeds.data)
  const norm = Math.hypot(...v)
  vectors.push(v.map((x) => x / norm))
  timings.push(performance.now() - t)
}
await writeFile(
  'output/search-models/benchmark.json',
  JSON.stringify({ samples, vectors, timings, elapsed: performance.now() - start }),
)
console.log(
  JSON.stringify({
    warmMilliseconds: timings,
    totalMilliseconds: performance.now() - start,
    dimensions: vectors[0].length,
    rssMiB: Math.round(process.memoryUsage().rss / 1048576),
  }),
)
