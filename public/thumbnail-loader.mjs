/** Memory-only bytes, never authority: callers need a current session-bound grant.
 * The server still validates every cache miss. Never applies to shares or originals. */
export function createThumbnailMemory(win) {
  const entries = new Map()
  let bytes = 0
  let clearTimer = null
  let generation = 0
  const limit = 16 * 1024 * 1024
  function clear() {
    entries.clear()
    bytes = 0
    generation++
    win.clearTimeout(clearTimer)
    clearTimer = null
  }
  win.addEventListener('gallery-logout', clear)
  function key(src) {
    try {
      const url = new URL(src, win.location.origin)
      if (
        url.origin !== win.location.origin ||
        url.pathname !== '/api/images' ||
        url.searchParams.has('download')
      )
        return null
      const token = url.searchParams.get('grant')
      if (!token || token.length > 2048 || token.split('.').length !== 2) return null
      const body = JSON.parse(atob(token.split('.')[0].replaceAll('-', '+').replaceAll('_', '/')))
      const now = Math.floor(Date.now() / 1000)
      if (
        body.v !== 1 ||
        body.variant !== 'thumbnail' ||
        body.aud !== url.origin ||
        typeof body.sid !== 'string' ||
        !body.sid ||
        typeof body.sub !== 'string' ||
        !body.sub ||
        !Number.isInteger(body.iat) ||
        !Number.isInteger(body.exp) ||
        body.iat > now + 5 ||
        body.exp <= now ||
        body.exp <= body.iat ||
        body.exp - body.iat > 60 ||
        body.path !== url.searchParams.get('path') ||
        !/^thumbnails\/400\/[1-9][0-9]*\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/image\.jpg$/.test(
          body.path,
        )
      )
        return null
      // Parsing here selects already downloaded bytes; it is not signature verification.
      return JSON.stringify([body.sid, body.sub, body.path])
    } catch {
      return null
    }
  }
  function get(src) {
    const id = key(src)
    const entry = id && entries.get(id)
    if (!entry) return null
    if (entry.expires <= Date.now()) {
      entries.delete(id)
      bytes -= entry.blob.size
      return null
    }
    entries.delete(id)
    entries.set(id, entry)
    return entry.blob
  }
  function put(src, blob, expectedGeneration) {
    const id = key(src)
    if (
      !id ||
      generation !== expectedGeneration ||
      blob.type !== 'image/jpeg' ||
      !blob.size ||
      blob.size > 512 * 1024
    )
      return
    const old = entries.get(id)
    if (old) {
      bytes -= old.blob.size
      entries.delete(id)
    }
    while (entries.size >= 400 || bytes + blob.size > limit) {
      const oldest = entries.keys().next().value
      bytes -= entries.get(oldest).blob.size
      entries.delete(oldest)
    }
    entries.set(id, { blob, expires: Date.now() + 300000 })
    bytes += blob.size
    // No idle polling; expire the entire cache after at most five minutes.
    if (clearTimer === null) clearTimer = win.setTimeout(clear, 300000)
  }
  function remove(src) {
    const id = key(src)
    const entry = entries.get(id)
    if (entry) {
      entries.delete(id)
      bytes -= entry.blob.size
    }
  }
  return { get, put, remove, eligible: (src) => !!key(src), generation: () => generation }
}

/** Shared by React grids and public albums. Permission-specific batch transport is injected; scheduling is shared by every grid.
 * @param {any} win
 * @param {{concurrency?: number, preload?: number, previewBatch?: null | {path: (src: string, origin: string) => string | null, fetch: (path: string, signal: AbortSignal) => Promise<Blob>}}} options
 */
export function createThumbnailLoader(
  win,
  { previewBatch = null, concurrency = previewBatch ? 24 : 6, preload = 300 } = {},
) {
  const memory = createThumbnailMemory(win)
  const jobs = new Set()
  let active = 0
  let frame = null
  let listening = false
  const observer = win.IntersectionObserver
    ? new win.IntersectionObserver(schedule, { rootMargin: `${preload}px` })
    : null
  function schedule() {
    if (frame === null) frame = win.requestAnimationFrame(pump)
  }
  function pump() {
    frame = null
    const candidates = []
    const distantRunning = []
    for (const job of jobs) {
      const rect = job.image.getBoundingClientRect()
      const visible =
        rect.bottom > 0 &&
        rect.top < win.innerHeight &&
        rect.right > 0 &&
        rect.left < win.innerWidth
      const nearby =
        rect.bottom > -preload &&
        rect.top < win.innerHeight + preload &&
        rect.right > -preload &&
        rect.left < win.innerWidth + preload
      job.image.fetchPriority = visible ? 'high' : 'low'
      if (job.running && !nearby) distantRunning.push(job)
      if (!job.running && !job.timer && nearby && rect.width > 0 && rect.height > 0)
        candidates.push({ job, visible, top: rect.top, left: rect.left })
    }
    candidates.sort(
      (a, b) => Number(b.visible) - Number(a.visible) || a.top - b.top || a.left - b.left,
    )
    // A fast scroll must not leave visible tiles behind off-screen transfers.
    // Keep near-viewport work to avoid churn; cancel only as many distant jobs
    // as needed, without consuming their failure/retry budget.
    const visibleWaiting = candidates.filter((item) => item.visible).length
    let slotsNeeded = Math.max(0, Math.min(concurrency, visibleWaiting) - (concurrency - active))
    for (const job of distantRunning) {
      if (slotsNeeded-- <= 0) break
      release(job)
      job.image.removeAttribute('src')
      state(job, 'deferred')
    }
    for (const { job } of candidates) {
      if (active >= concurrency) break
      start(job)
    }
  }
  function listen() {
    if (listening) return
    listening = true
    win.addEventListener('scroll', schedule, { passive: true, capture: true })
    win.addEventListener('resize', schedule, { passive: true })
  }
  function release(job) {
    if (job.running) {
      job.running = false
      active--
    }
    win.clearTimeout(job.timer)
    job.timer = null
    job.controller?.abort()
    job.controller = null
    if (job.objectUrl) {
      win.URL.revokeObjectURL(job.objectUrl)
      job.objectUrl = null
    }
  }
  function detach(job) {
    release(job)
    jobs.delete(job)
    observer?.unobserve(job.image)
    job.image.removeEventListener('load', job.loaded)
    job.image.removeEventListener('error', job.failed)
    if (!jobs.size) {
      win.removeEventListener('scroll', schedule, true)
      win.removeEventListener('resize', schedule)
      listening = false
      if (frame !== null) win.cancelAnimationFrame(frame)
      frame = null
      observer?.disconnect()
    } else schedule()
  }
  function state(job, value) {
    job.image.dataset.thumbnailState = value
    job.image.dataset.thumbnailAttempt = String(job.attempt)
    job.onState(value)
  }
  function start(job) {
    job.running = true
    active++
    state(job, 'loading')
    job.image.loading = 'eager'
    job.image.decoding = 'async'
    job.timer = win.setTimeout(job.failed, 25000)
    const source = job.attempt
      ? `${job.src}${job.src.includes('?') ? '&' : '?'}thumbnailRetry=${job.attempt}`
      : job.src
    const batchPath =
      !job.attempt && previewBatch ? previewBatch.path(source, win.location?.origin) : null
    if (!batchPath && !memory.eligible(source)) {
      job.image.src = source
      return
    }
    const attempt = job.attempt
    const controller = new AbortController()
    job.controller = controller
    const generation = memory.generation()
    void (async () => {
      try {
        let blob = memory.get(source)
        if (!blob) {
          if (batchPath) {
            blob = await previewBatch.fetch(batchPath, controller.signal)
          } else {
            const response = await win.fetch(source, {
              signal: controller.signal,
              credentials: 'same-origin',
              priority: job.image.fetchPriority,
            })
            if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
              await response.body?.cancel()
              throw Error('Thumbnail unavailable')
            }
            blob = await response.blob()
          }
          if (controller.signal.aborted || !job.running || job.attempt !== attempt) return
          memory.put(source, blob, generation)
        }
        if (controller.signal.aborted || !job.running || job.attempt !== attempt) return
        job.objectUrl = win.URL.createObjectURL(blob)
        job.image.src = job.objectUrl
      } catch {
        if (!controller.signal.aborted && job.running && job.attempt === attempt) job.failed()
      }
    })()
  }
  /** @param {(state: string) => void} onState */
  function observe(image, src, onState = () => {}) {
    const job = { image, src, onState, running: false, timer: null, attempt: 0 }
    job.loaded = () => {
      if (!job.running) return
      detach(job)
      state(job, 'loaded')
    }
    job.failed = () => {
      if (!job.running) return
      release(job)
      memory.remove(job.src)
      // Stop a silent stall before releasing capacity for another image.
      image.removeAttribute('src')
      if (job.attempt >= 2) {
        detach(job)
        state(job, 'failed')
      } else {
        job.attempt++
        state(job, 'retrying')
        job.timer = win.setTimeout(() => {
          job.timer = null
          schedule()
        }, 750 * job.attempt)
        schedule()
      }
    }
    jobs.add(job)
    image.addEventListener('load', job.loaded)
    image.addEventListener('error', job.failed)
    state(job, 'deferred')
    observer?.observe(image)
    listen()
    schedule()
    return () => {
      const running = job.running
      detach(job)
      if (running) image.removeAttribute('src')
    }
  }
  return { observe }
}

/** Public albums append pages without React. Keep the exact same loading policy. */
export function mountThumbnailGrid(win, grid, options = {}) {
  const loader = createThumbnailLoader(win, options)
  const registrations = new Map()
  function scan() {
    for (const [image, dispose] of registrations) {
      if (!grid.contains(image)) {
        dispose()
        registrations.delete(image)
      }
    }
    for (const image of grid.querySelectorAll('img[data-thumbnail-src]')) {
      if (registrations.has(image)) continue
      registrations.set(
        image,
        loader.observe(image, image.dataset.thumbnailSrc, (state) => {
          image.title = state === 'failed' ? 'Image unavailable. Select to retry.' : ''
          if (state === 'failed') image.alt = 'Retry image'
        }),
      )
    }
  }
  function retry(event) {
    const image = event.target
      .closest('button')
      ?.querySelector('img[data-thumbnail-state="failed"]')
    if (!image) return
    event.preventDefault()
    event.stopImmediatePropagation()
    registrations.get(image)?.()
    registrations.delete(image)
    scan()
  }
  const mutation = new win.MutationObserver(scan)
  mutation.observe(grid, { childList: true, subtree: true })
  grid.addEventListener('click', retry, true)
  scan()
  return () => {
    mutation.disconnect()
    grid.removeEventListener('click', retry, true)
    for (const dispose of registrations.values()) dispose()
    registrations.clear()
  }
}
