/** Deterministic local scale profile of real loaders/rankers. No providers or production data. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const directory = await mkdtemp(join(tmpdir(), 'stillmark-scale-'))
try {
  await build({
    stdin: {
      contents: `export { loadPhotoPages } from './lib/photos/photo-grid-loader'; export { withEligibleMatches, withFusedMatches } from './lib/search/search-eligibility'; export { hydrateRankedPhotos } from './lib/search/search-hydration';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(directory, 'profile.mjs'),
  })
  const { loadPhotoPages, withEligibleMatches, withFusedMatches, hydrateRankedPhotos } =
    await import(pathToFileURL(join(directory, 'profile.mjs')))
  const reports = []
  for (const count of [10000, 84000]) {
    let calls = 0
    globalThis.fetch = async (url) => {
      calls++
      const start = Number(new URL(url, 'http://localhost').searchParams.get('cursor') || 0)
      const end = Math.min(start + 96, count)
      return Response.json({
        items: Array.from({ length: end - start }, (_, index) => ({
          photoId: start + index + 1,
          eventId: 7,
          sourceFilename: 'synthetic.jpg',
          thumbnailUrl: null,
          aspectRatio: 1,
          mediaType: 'photo',
          favorite: false,
        })),
        nextCursor: end < count ? String(end) : null,
      })
    }
    const started = performance.now()
    const result = await loadPhotoPages({
      eventId: 7,
      query: '',
      target: count,
      signal: new AbortController().signal,
    })
    assert.equal(result.items.length, count)
    assert.equal(new Set(result.items.map((p) => p.photoId)).size, count)
    assert.equal(calls, Math.ceil(count / 96))
    const restoreMs = performance.now() - started
    calls = 0
    const cachedStart = performance.now()
    const cached = await loadPhotoPages({
      eventId: 7,
      query: '',
      target: count,
      snapshot: result,
      signal: new AbortController().signal,
    })
    assert.equal(
      calls,
      1,
      'Returning to a deep gallery must authorize once, then reuse its snapshot',
    )
    assert.equal(cached.items.length, count)
    reports.push({
      kind: 'gallery',
      count,
      restoreMs,
      cachedReturnMs: performance.now() - cachedStart,
      requests: Math.ceil(count / 96),
      cachedRequests: calls,
    })
  }
  for (const count of [84000, 1000000, 10000000]) {
    globalThis.gc?.()
    const initialHeap = process.memoryUsage().heapUsed
    let peak = initialHeap
    let calls = 0
    let largest = 0
    const started = performance.now()
    const result = await withEligibleMatches(
      async (after, limit) =>
        Array.from({ length: Math.min(limit, count - after) }, (_, i) => after + i + 1),
      async (ids) => {
        calls++
        largest = Math.max(largest, ids.length)
        // Actual provider maximum: up to 1000 candidates per 5000-ID partition.
        const matches = new Map(
          ids.filter((_, i) => i % 5000 < 1000).map((id) => [id, { reranker_score: id / count }]),
        )
        peak = Math.max(peak, process.memoryUsage().heapUsed)
        return matches
      },
      2,
      async (matches) => {
        let size = 0
        let previous = Infinity
        for await (const row of matches.ordered()) {
          assert.ok(row.scores.reranker_score <= previous)
          previous = row.scores.reranker_score
          size++
          if (size % 10000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed)
        }
        return { size }
      },
    )
    peak = Math.max(peak, process.memoryUsage().heapUsed)
    const expected = Math.floor(count / 5000) * 1000 + Math.min(count % 5000, 1000)
    assert.equal(result.size, expected, 'Never truncate candidates to satisfy a memory target')
    assert.equal(calls, Math.ceil(count / 10000))
    assert.ok(largest <= 10000)
    reports.push({
      kind: 'semantic',
      eligible: count,
      candidates: result.size,
      calls,
      largestPage: largest,
      elapsedMs: performance.now() - started,
      heapGrowthMiB: (peak - initialHeap) / 1048576,
    })
  }
  // Exercise the complete intermediate pipeline under the actual four-search
  // admission ceiling, not just one sort in isolation. Provider/network latency
  // is intentionally absent: this measures local CPU, heap and event-loop delay.
  for (const [concurrent, eligible] of [
    [1, 10000000],
    [4, 1000000],
  ]) {
    const delay = monitorEventLoopDelay({ resolution: 10 })
    delay.enable()
    globalThis.gc?.()
    const initialHeap = process.memoryUsage().heapUsed
    let peak = initialHeap
    const started = performance.now()
    let counts
    try {
      counts = await Promise.all(
        Array.from({ length: concurrent }, async () =>
          withEligibleMatches(
            async (after, limit) =>
              Array.from({ length: Math.min(limit, eligible - after) }, (_, i) => after + i + 1),
            async (ids) =>
              new Map(
                ids
                  .filter((_, i) => i % 5000 < 1000)
                  .map((id) => [id, { reranker_score: id / eligible }]),
              ),
            2,
            async (semantic) =>
              withFusedMatches(semantic, [1, eligible + 1], [2, eligible + 1], async (rows) => {
                let count = 0
                const seen = new Set()
                for await (const row of rows) {
                  if (count < 10) seen.add(row.id)
                  count++
                  if (count % 10000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed)
                }
                assert.ok(seen.has(eligible + 1), 'Lexical-only candidate must survive full fusion')
                assert.equal(count, eligible / 5 + 1)
                return count
              }),
          ),
        ),
      )
    } finally {
      delay.disable()
    }
    reports.push({
      kind: 'full-fusion',
      concurrent,
      eligiblePerSearch: eligible,
      candidates: counts,
      elapsedMs: performance.now() - started,
      heapGrowthMiB: (peak - initialHeap) / 1048576,
      eventLoopP99Ms: delay.percentile(99) / 1000000,
      eventLoopMaxMs: delay.max / 1000000,
    })
  }
  const ids = Array.from({ length: 100000 }, (_, i) => i + 1)
  let batches = 0
  const started = performance.now()
  const ranked = await hydrateRankedPhotos('rider number 6', ids, 50, async (batch) => {
    batches++
    assert.ok(batch.length <= 200)
    return batch.map((photoId) => ({
      photoId,
      aiDescription: photoId === 100000 ? 'Rider number 6.' : 'Rider number 57.',
    }))
  })
  assert.deepEqual(
    ranked.map((p) => p.photoId),
    [100000],
    'Late exact evidence must survive broad ranking',
  )
  reports.push({
    kind: 'hydration',
    candidates: ids.length,
    batches,
    elapsedMs: performance.now() - started,
  })
  const output = {
    node: process.version,
    scope: 'Local synthetic CPU/memory; excludes network, providers and production capacity',
    reports,
  }
  if (process.env.CATALOG_SCALE_REPORT)
    await writeFile(process.env.CATALOG_SCALE_REPORT, JSON.stringify(output, null, 2) + '\n')
  console.log(JSON.stringify(output, null, 2))
} finally {
  await rm(directory, { recursive: true, force: true })
}
