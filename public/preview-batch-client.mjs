import { PREVIEW_BATCH_LIMIT, previewPath, readPreviewBatch } from './preview-batch.mjs'

export function batchPreviewPath(src, origin) {
  try {
    const url = new URL(src, origin)
    if (
      url.origin !== origin ||
      url.pathname !== '/api/images' ||
      url.searchParams.get('batch') !== '1' ||
      [...url.searchParams.keys()].some((key) => !['path', 'grant', 'batch'].includes(key)) ||
      url.searchParams.getAll('path').length !== 1
    )
      return null
    const path = url.searchParams.get('path')
    return previewPath(path) ? path : null
  } catch {
    return null
  }
}
/** Cancel one tile without aborting others; abort transport when all consumers leave. */
export function createPreviewBatchClient(win, endpoint = '/api/images/batch', field = 'paths') {
  // Bytes are reusable only after the current request passes live server authorization.
  // Only preview bytes are retained; never permissions, originals, or storage URLs.
  const cache = new Map()
  let bytes = 0
  let epoch = 0
  const clear = () => {
    cache.clear()
    bytes = 0
    epoch++
  }
  win.addEventListener?.('gallery-logout', clear)
  const versioned = field === 'ids'
  const remember = (path, blob, version) => {
    if (
      versioned
        ? !Number.isSafeInteger(Number(path)) ||
          Number(path) < 1 ||
          !/^[0-9a-f]{64}$/.test(version ?? '')
        : endpoint !== '/api/images/batch' || !previewPath(path)
    )
      return
    const old = cache.get(path)
    if (old) {
      bytes -= old.blob.size
      cache.delete(path)
    }
    while (cache.size && (cache.size >= 800 || bytes + blob.size > 32 * 1024 * 1024)) {
      const oldest = cache.keys().next().value
      bytes -= cache.get(oldest).blob.size
      cache.delete(oldest)
    }
    cache.set(path, { blob, version, expires: Date.now() + 300000 })
    bytes += blob.size
  }
  let pending = []
  let scheduled = false
  async function flush() {
    scheduled = false
    const items = pending.splice(0, PREVIEW_BATCH_LIMIT).filter((item) => !item.signal.aborted)
    if (pending.length) schedule()
    if (!items.length) return
    const generation = epoch
    const retained = items.map((item) => {
      const entry = cache.get(item.path)
      if (entry && entry.expires > Date.now()) return entry.blob
      if (entry) {
        bytes -= entry.blob.size
        cache.delete(item.path)
      }
      return null
    })
    const cached = items.filter((_, i) => retained[i]).map((item) => item.path)
    const controller = new AbortController()
    const cancel = () => {
      if (items.every((item) => item.signal.aborted)) controller.abort()
    }
    items.forEach((item) => item.signal.addEventListener('abort', cancel, { once: true }))
    const timer = win.setTimeout(() => controller.abort(), 20000)
    const settled = new Set()
    try {
      const response = await win.fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          [field]: items.map((item) => item.path),
          ...(cached.length
            ? {
                cached: versioned
                  ? cached.map((id) => ({ id, version: cache.get(id)?.version }))
                  : cached,
              }
            : {}),
        }),
      })
      let versions = []
      if (versioned) {
        try {
          versions = JSON.parse(response.headers.get('x-preview-versions') ?? '[]')
        } catch {}
        if (!Array.isArray(versions)) versions = []
      }
      await readPreviewBatch(response, items.length, (i, blob, status) => {
        if (generation !== epoch) {
          items[i].reject(Error('Session changed'))
          settled.add(i)
          return
        }
        if (status === 304) blob = retained[i]
        else if (blob) remember(items[i].path, blob, versions[i])
        else {
          const entry = cache.get(items[i].path)
          if (entry) {
            bytes -= entry.blob.size
            cache.delete(items[i].path)
          }
        }
        settled.add(i)
        if (blob && !items[i].signal.aborted) items[i].resolve(blob)
        else items[i].reject(Error('Preview unavailable'))
      })
    } catch (error) {
      items.forEach((item, i) => {
        if (!settled.has(i)) item.reject(error)
      })
    } finally {
      win.clearTimeout(timer)
      items.forEach((item) => item.signal.removeEventListener('abort', cancel))
    }
  }
  function schedule() {
    if (!scheduled) {
      scheduled = true
      // Coalesce completions within half a frame instead of sending one request per image.
      win.setTimeout(flush, 8)
    }
  }
  return (path, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(Error('Cancelled'))
        return
      }
      const item = { path, signal, resolve, reject }
      const cancel = () => {
        pending = pending.filter((value) => value !== item)
        reject(Error('Cancelled'))
      }
      signal.addEventListener('abort', cancel, { once: true })
      const finish = (fn) => (value) => {
        signal.removeEventListener('abort', cancel)
        fn(value)
      }
      item.resolve = finish(resolve)
      item.reject = finish(reject)
      pending.push(item)
      schedule()
    })
}

/** One authenticated transport adapter; all grids use the same scheduler and client. */
export function createAppPreviewTransport(win) {
  const normal = createPreviewBatchClient(win)
  const clients = new Map(
    ['faces', 'trash'].map((kind) => [
      kind,
      createPreviewBatchClient(win, '/api/' + kind + '/batch', 'ids'),
    ]),
  )
  return {
    path(src, origin) {
      const url = new URL(src, origin)
      if (url.origin !== origin) return null
      const match = /^\/api\/(faces|trash)\/([1-9][0-9]*)\/(crop|thumbnail)$/.exec(url.pathname)
      if (
        match &&
        !url.search &&
        ((match[1] === 'faces' && match[3] === 'crop') ||
          (match[1] === 'trash' && match[3] === 'thumbnail'))
      )
        return match[1] + ':' + match[2]
      return batchPreviewPath(src, origin)
    },
    fetch(path, signal) {
      const match = /^(faces|trash):([1-9][0-9]*)$/.exec(path)
      return match ? clients.get(match[1])(Number(match[2]), signal) : normal(path, signal)
    },
  }
}
