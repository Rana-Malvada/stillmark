// Offline replay of production snapshots: no network, credentials, or model calls.
// Usage: node scripts/search/evaluate.mjs /absolute/path/to/private/evaluation
import fs from 'node:fs'
import path from 'node:path'
import {
  allowsVisualSearch,
  guardedBatchOrder,
  protectEvidence,
  rankingDocuments,
} from '../../lib/search/search-evidence.ts'

const root = path.resolve(process.argv[2] || 'output/search-evaluation')
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
const sessions = read('sessions.json')
const evidence = new Map(read('current-evidence.json').map((row) => [row.photoId, row]))
const oldRanks = read('rerank.json')
const newRanks = fs.existsSync(path.join(root, 'rerank-v2.json')) ? read('rerank-v2.json') : []
const revised = sessions.map((s) => ({
  ...s,
  documents: rankingDocuments(
    s.documents.map((d) => ({
      ...evidence.get(d.id),
      ...s.payload.rankScores?.[d.id],
      photoId: d.id,
    })),
    s.query,
  ),
}))
fs.writeFileSync(path.join(root, 'sessions-v2.json'), JSON.stringify(revised))
const report = []
for (const s of revised) {
  const rows = s.candidate_ids.map((id) => evidence.get(id)).filter(Boolean)
  const protectedIds = protectEvidence(s.query, rows).map((row) => row.photoId)
  const old = oldRanks.find((r) => r.query === s.query)
  const updated = newRanks.find((r) => r.query === s.query)
  // Compare identical candidate pools: the optional CPU replay processes first 200.
  const pool = new Set((updated || old)?.ids || s.candidate_ids)
  const baseline = s.candidate_ids.filter((id) => pool.has(id))
  const combined = guardedBatchOrder(
    protectedIds.filter((id) => pool.has(id)),
    updated?.ids || old?.ids || baseline,
    s.documents,
  )
  report.push({
    query: s.query,
    baseline: baseline.slice(0, 10),
    protected: protectedIds.slice(0, 10),
    oldModel: old?.ids.slice(0, 10),
    newModel: updated?.ids.slice(0, 10),
    combined: combined.slice(0, 10),
    visualAllowed: allowsVisualSearch(s.payload.rankingQuery || s.query),
    rerankSeconds: updated?.seconds,
    evidence: combined.slice(0, 5).map((id) => ({
      id,
      description: evidence.get(id)?.aiDescription,
      tier: s.documents.find((d) => d.id === id)?.evidenceTier,
    })),
  })
}
fs.writeFileSync(
  path.join(root, 'comparison.json'),
  JSON.stringify(
    {
      method:
        'Offline historical candidate replay with current photo evidence. Top-200 model pool; no fresh Cortex retrieval or full-library recall measurement. Descriptions/OCR are evidence proxies, not independently adjudicated ground truth.',
      queries: report,
    },
    null,
    2,
  ),
)
console.log(
  JSON.stringify(
    report.map(({ query, baseline, combined, visualAllowed }) => ({
      query,
      baseline,
      combined,
      visualAllowed,
    })),
    null,
    2,
  ),
)
