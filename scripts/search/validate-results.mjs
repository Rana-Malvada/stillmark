// Offline evaluation: no credentials, network, production mutations, or model calls.
// node scripts/search/validate-results.mjs SNAPSHOT.json MODEL_RESULTS.json OUTPUT.json
// MODEL_RESULTS may be an empty JSON array when evaluating retrieval alone.
import fs from 'node:fs'
import { applySearchQuality } from '../../lib/search/search-quality.ts'
import { guardedBatchOrder, rankingDocuments } from '../../lib/search/search-evidence.ts'

const [snapshot, modelsPath, output] = process.argv.slice(2)
if (!snapshot || !modelsPath || !output)
  throw Error('Expected snapshot, model results, output paths')
const rows = JSON.parse(fs.readFileSync(snapshot, 'utf8')).results
const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'))
const report = rows.map((r) => {
  const current = r.updated
  const quality = applySearchQuality(current)
  const related = applySearchQuality(current, true)
  if (related.results.length !== current.results.length) throw Error('Related mode lost candidates')
  const model = models.find((m) => m.query === r.query)
  // Compare only the candidate pool actually processed by the finite CPU job.
  const pool = current.results.slice(0, 200)
  const ids = pool.map((p) => p.photoId)
  const docs = rankingDocuments(pool, r.query)
  const batch = model ? guardedBatchOrder(ids, model.ids, docs) : null
  if (batch && (batch.length !== ids.length || batch.some((id) => !ids.includes(id))))
    throw Error('Batch changed candidates')
  const strongest = new Set(docs.filter((d) => d.retrievalTier === 1).map((d) => d.id))
  return {
    query: r.query,
    semantic: r.semantic,
    before: current.count,
    after: quality.count,
    relatedAvailable: quality.relatedAvailable ?? false,
    baselineTop5: ids.slice(0, 5),
    batchTop5: batch?.slice(0, 5),
    protectedGroup: [...strongest],
    allProtectedRemainFirst:
      !batch || !strongest.size || batch.slice(0, strongest.size).every((id) => strongest.has(id)),
    modelSeconds: model?.seconds,
  }
})
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      method:
        'Offline replay of saved authorized results; not fresh retrieval, complete recall or production latency certification.',
      queries: report,
    },
    null,
    2,
  ),
)
console.log(
  JSON.stringify(
    {
      queries: report.length,
      abstentions: report.filter((r) => r.relatedAvailable).map((r) => r.query),
      batchQueries: report.filter((r) => r.batchTop5).length,
    },
    null,
    2,
  ),
)
