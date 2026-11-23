import { flagNotOff, flagOn } from '@/lib/flags'

export async function register() {
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.NEXT_PHASE !== 'phase-production-build'
  ) {
    const { installProductionDiagnostics } =
      await import('./lib/observability/production-diagnostics')
    installProductionDiagnostics()
    const { installLoadTestHttpLifecycle } = await import('./lib/load-test-http-lifecycle')
    installLoadTestHttpLifecycle()
  }
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.NEXT_PHASE !== 'phase-production-build' &&
    process.env.UPLOAD_SERVICE_ONLY === 'true' &&
    flagOn('UPLOAD_PROCESSING_QUEUE_ENABLED') &&
    flagNotOff('UPLOAD_PROCESSING_WORKER_ENABLED')
  ) {
    const { startUploadProcessingWorker } = await import('./lib/upload/upload-processing-worker')
    startUploadProcessingWorker()
    if (flagOn('UPLOAD_QUEUE_METRICS_ENABLED')) {
      const { startUploadQueueMetrics } = await import('./lib/upload/upload-queue-metrics')
      startUploadQueueMetrics()
    }
  }
  if (
    process.env.NEXT_RUNTIME !== 'nodejs' ||
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.UPLOAD_SERVICE_ONLY === 'true' ||
    !flagOn('BACKGROUND_JOBS_ENABLED') ||
    process.env.BACKGROUND_EXECUTION_ROLE === 'web'
  )
    return
  const { startBackgroundCoordinator } = await import('./lib/database/background-coordinator')
  const { createPhotoAiListener } = await import('./lib/photos/photo-ai-listener')
  const { createPhotoAiListenerClient } = await import('./lib/postgres')
  const { drainPhotoAiQueue } = await import('./lib/photos/photo-ai-queue')
  const listenForPhotos = createPhotoAiListener(createPhotoAiListenerClient, async () => {
    if (!isCoordinator()) return
    wakeAutomaticWorkers()
    await drainPhotoAiQueue()
  })
  const isCoordinator = startBackgroundCoordinator(listenForPhotos)
  const assertionCleanup = async () => {
    if (!isCoordinator()) return
    try {
      const { withServiceDatabase } = await import('./lib/database/database-context')
      const { pgQuery } = await import('./lib/postgres')
      await withServiceDatabase(() => pgQuery('SELECT photo_security.cleanup_gateway_assertions()'))
    } catch (error) {
      console.error('[assertion-cleanup]', error)
    }
  }
  setInterval(assertionCleanup, 15000).unref()
  let switchingUploadMode = false
  const uploadRoutingTick = async () => {
    if (!isCoordinator()) return
    if (switchingUploadMode) return
    switchingUploadMode = true
    try {
      const { maintainUploadRouting } = await import('./lib/upload/upload-routing')
      await maintainUploadRouting()
    } catch (error) {
      console.error('[upload-routing-maintenance]', error)
    } finally {
      switchingUploadMode = false
    }
  }
  setTimeout(uploadRoutingTick, 1000).unref()
  setInterval(uploadRoutingTick, 10000).unref()
  const videoTick = async () => {
    if (!isCoordinator()) return
    try {
      const { processVideoAnalyses } = await import('@/lib/video/video-analysis')
      await processVideoAnalyses()
    } catch (e) {
      console.error('[video-maintenance]', e)
    }
  }
  setTimeout(videoTick, 15000).unref()
  setInterval(videoTick, 30000).unref()
  const playbackTick = async () => {
    if (!isCoordinator()) return
    try {
      const { processVideoPlayback } = await import('./lib/video/video-playback')
      await processVideoPlayback()
    } catch (e) {
      console.error('[playback-maintenance]', e)
    }
  }
  setTimeout(playbackTick, 20000).unref()
  setInterval(playbackTick, 10000).unref()
  let checkingPreparation = false
  const preparationTick = async () => {
    if (!isCoordinator()) return
    if (checkingPreparation) return
    checkingPreparation = true
    try {
      const { maintainPreparation } = await import('./lib/video/video-preparation')
      await maintainPreparation()
    } catch (e) {
      console.error('[preparation-maintenance]', e)
    } finally {
      checkingPreparation = false
    }
  }
  setInterval(preparationTick, 30000).unref()
  let checkingFaceScan = false
  const faceScanTick = async () => {
    if (!isCoordinator()) return
    if (checkingFaceScan) return
    checkingFaceScan = true
    try {
      const { maintainFaceScan } = await import('./lib/people/face-scan')
      await maintainFaceScan()
    } catch (e) {
      console.error('[face-scan-maintenance]', e)
    } finally {
      checkingFaceScan = false
    }
  }
  setInterval(faceScanTick, 30000).unref()
  let checkingSearchBatch = false
  const searchBatchTick = async () => {
    if (!isCoordinator()) return
    if (checkingSearchBatch) return
    checkingSearchBatch = true
    try {
      const { maintainSearchBatch } = await import('./lib/search/search-batch')
      await maintainSearchBatch()
    } catch (error) {
      console.error('[search-batch-maintenance]', error)
    } finally {
      checkingSearchBatch = false
    }
  }
  setInterval(searchBatchTick, 60000).unref()

  let publishingSearch = false
  const publishingTick = async () => {
    if (!isCoordinator() || publishingSearch) return
    publishingSearch = true
    try {
      const { maintainAutomaticSearch } = await import('./lib/search/automatic-search')
      await maintainAutomaticSearch()
    } catch (error) {
      console.error('[search-publishing-maintenance]', error)
    } finally {
      publishingSearch = false
    }
  }
  // Batch warehouse publication independently; a slow publisher never blocks OCR admission.
  setInterval(publishingTick, 60000).unref()

  let automaticWake: ReturnType<typeof setTimeout> | undefined
  function wakeAutomaticWorkers() {
    if (!flagOn('AUTOMATIC_MEDIA_PROCESSING_ENABLED') || automaticWake) return
    // Commit notifications coalesce an upload burst without adding idle polling.
    automaticWake = setTimeout(() => {
      automaticWake = undefined
      void Promise.allSettled([faceScanTick(), preparationTick(), searchBatchTick()])
    }, 1000)
    automaticWake.unref()
  }

  let matchingPeople = false
  const matchingTick = async () => {
    if (!isCoordinator()) return
    if (matchingPeople) return
    matchingPeople = true
    try {
      const { maintainPeopleMatching } = await import('./lib/people/people-matching')
      await maintainPeopleMatching()
    } catch (error) {
      console.error('[people-matching]', error)
    } finally {
      matchingPeople = false
    }
  }
  setInterval(matchingTick, 10000).unref()
  // Recover delayed retries, expired claims and missed notifications.
  const photoAiTick = async () => {
    if (!isCoordinator()) return
    try {
      await drainPhotoAiQueue()
    } catch (error) {
      console.error('[photo-ai]', error)
    }
  }
  setInterval(photoAiTick, 60_000).unref()
  let running = false
  const tick = async () => {
    if (!isCoordinator()) return
    if (running) return
    running = true
    try {
      const { purgeExpiredTrash } = await import('@/lib/photos/photo-management')
      const { cleanupStage } = await import('@/lib/snowflake/stage-upload')
      const { cleanupActivity } = await import('@/lib/observability/user-activity')
      const { pgQuery } = await import('@/lib/postgres')
      const { withServiceDatabase } = await import('@/lib/database/database-context')
      // Independent tasks still run when one fails. Their database locks prevent cross-instance overlap.
      for (const job of [
        purgeExpiredTrash,
        cleanupStage,
        cleanupActivity,
        () =>
          withServiceDatabase(() =>
            pgQuery(
              `DELETE FROM upload_sessions WHERE expires_at<NOW() AND NOT EXISTS (SELECT 1 FROM upload_processing_jobs j WHERE j.upload_id=upload_sessions.upload_id AND j.state IN ('queued','processing'))`,
            ),
          ),
      ]) {
        try {
          await job()
        } catch (error) {
          console.error('[maintenance]', error)
        }
      }
    } finally {
      running = false
    }
  }
  setTimeout(tick, 30_000).unref()
  setInterval(tick, 60_000).unref()
}
