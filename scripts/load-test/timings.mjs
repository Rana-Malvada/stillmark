/** Database transition times, never client polling estimates. Retried jobs retain every attempt. */
export function summarizeTimings(rows, expectedIds) {
  const expected = new Set(expectedIds)
  if (expected.size !== expectedIds.length) throw Error('Duplicate expected upload IDs')
  const grouped = new Map()
  for (const row of rows) {
    if (!expected.has(row.upload_id)) throw Error('Unexpected upload outside run')
    const time = Date.parse(row.occurred_at)
    if (!Number.isFinite(time) || !Number.isSafeInteger(Number(row.sequence)))
      throw Error('Invalid transition timestamp or sequence')
    const events = grouped.get(row.upload_id) ?? []
    events.push({ ...row, time, sequence: Number(row.sequence) })
    grouped.set(row.upload_id, events)
  }
  const jobs = []
  for (const id of expected) {
    const events = (grouped.get(id) ?? []).sort((a, b) => a.sequence - b.sequence)
    let queued
    let claim
    let accepted
    let finished
    let invalid = false
    const attempts = []
    for (const event of events) {
      if (event.state === 'queued') {
        if (claim) {
          attempts.push({ ...claim, end: event.time, outcome: 'retry' })
          claim = undefined
        }
        queued = event.time
        accepted ??= event.time
      } else if (event.state === 'processing') {
        if (claim) attempts.push({ ...claim, end: event.time, outcome: 'lease_reclaimed' })
        claim = {
          attempt: Number(event.attempt),
          start: event.time,
          queueMs: queued === undefined ? null : event.time - queued,
          executor: event.executor,
        }
        queued = undefined
      } else if (event.state === 'done' || event.state === 'failed') {
        if (claim) {
          attempts.push({ ...claim, end: event.time, outcome: event.state })
          claim = undefined
        } else invalid = true
        finished = event
      } else invalid = true
    }
    if (claim) attempts.push({ ...claim, end: null, outcome: 'incomplete' })
    const measurements = attempts.map((a) => ({
      ...a,
      processingMs: a.end === null ? null : a.end - a.start,
    }))
    if (
      measurements.some(
        (a) =>
          (a.queueMs !== null && a.queueMs < 0) || (a.processingMs !== null && a.processingMs < 0),
      ) ||
      (accepted !== undefined && finished && finished.time < accepted)
    )
      invalid = true
    jobs.push({
      uploadId: id,
      state: finished?.state ?? 'incomplete',
      complete: !invalid && accepted !== undefined && finished?.state === 'done',
      acceptedToDoneMs:
        accepted !== undefined && finished?.state === 'done' ? finished.time - accepted : null,
      attempts: measurements,
      invalid,
    })
  }
  const completed = jobs.filter((j) => j.complete)
  return {
    expected: expected.size,
    observed: grouped.size,
    completed: completed.length,
    allComplete: completed.length === expected.size && expected.size > 0,
    jobs,
  }
}
