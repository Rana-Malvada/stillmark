type Run = Record<string, unknown>
/** Completion belongs to the entire linked sequence, not just its first worker. */
export function searchBatchProgress(run: Run, parent?: Run, child?: Run, pendingPhotos = 0) {
  const root = parent ?? run
  const followup = parent ? run : child
  const needsFollowup = Number(root.photo_limit) > 0 && Number(root.search_limit) > 0
  let status = String(root.status)
  let message =
    Number(root.photo_limit) > 0
      ? 'Processing OCR and visual embeddings.'
      : 'Processing saved search rankings.'
  if (root.status === 'completed' && needsFollowup) {
    if (root.pipeline_error) {
      status = 'failed'
      message = String(root.pipeline_error)
    } else if (!followup) {
      status = 'follow-up pending'
      message =
        'Preparing the next batch or publishing search changes. The update continues automatically, up to three hours.'
    } else {
      status = String(followup.status)
      message =
        followup.status === 'completed'
          ? 'OCR, search publishing, and the saved-ranking follow-up have finished.'
          : `OCR and search publishing finished. Saved-ranking follow-up: ${followup.status}.`
      if (followup.error) message += ` ${followup.error}`
    }
  } else if (root.error) message = String(root.error)
  else if (root.status === 'completed')
    message =
      Number(root.photo_limit) > 0
        ? 'Enrichment batch finished. Run Sync Search to publish these changes; no automatic follow-up was requested.'
        : 'Saved-ranking batch finished.'
  const failures = Number(root.failures ?? 0) + Number(followup?.failures ?? 0)
  if (status === 'completed' && failures) status = 'completed with failures'
  if (status === 'completed' && pendingPhotos > 0) {
    status = 'batch finished — photos remaining'
    const limitReached =
      Number(root.photo_limit) > 0 && Number(root.photos_done) >= Number(root.photo_limit)
    message += ` ${pendingPhotos} photos are still queued. ${limitReached ? 'This batch reached its photo limit.' : 'Run another batch to process the remaining photos.'}`
  }
  return {
    status,
    message,
    failures,
    rootId: root.id,
    followupId: followup?.id ?? root.continued_by ?? null,
    photoLimit: Number(root.photo_limit ?? 0),
    photoElapsedMs: Number(root.elapsed_ms ?? 0),
    stage: !needsFollowup
      ? Number(root.photo_limit) > 0
        ? 0
        : 2
      : root.status !== 'completed'
        ? 0
        : followup
          ? 2
          : 1,
    photosDone: Number(root.photos_done ?? 0),
    searchesDone: Number((followup ?? root).searches_done ?? 0),
    canRetryFollowup:
      root.status === 'completed' && needsFollowup && !!root.pipeline_error && !root.continued_by,
    canStop: ['starting', 'running', 'follow-up pending'].includes(status),
    active: ['starting', 'running', 'follow-up pending'].includes(status),
  }
}
