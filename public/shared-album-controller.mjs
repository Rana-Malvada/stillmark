import { preloadWindow, ViewerImageBuffer } from './viewer-image-buffer.mjs'
import { isSharedPage, sharedJson, sharedRequest } from './shared-album-transport.mjs'

/** Public viewer lifecycle, independent of signed-in gallery authorization. */
export function mountSharedAlbum(
  { files: initialFiles, base, expires, nextPage: initialNextPage },
  environment = globalThis,
) {
  const {
    document,
    window,
    IntersectionObserver,
    innerHeight,
    fetch,
    setTimeout,
    setInterval,
    CustomEvent,
    Event,
  } = environment
  const files = [...initialFiles]
  let index = 0
  let nextPage = initialNextPage
  let loading = null
  let failed = false
  const lifetime = new AbortController()
  const expiryEl = document.getElementById('expiry')
  try {
    expiryEl.textContent = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(expires))
  } catch {}
  const viewer = document.getElementById('viewer')
  const media = document.getElementById('media')
  const notice = document.getElementById('notice')
  const grid = document.getElementById('grid')
  const loadingNotice = document.getElementById('loading')
  const menuToggle = document.getElementById('menu-toggle')
  const actions = document.getElementById('viewer-actions')
  function closeMenu() {
    actions.hidden = true
    menuToggle.setAttribute('aria-expanded', 'false')
  }
  document.querySelector('.viewer-menu').addEventListener('focusout', (e) => {
    if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) closeMenu()
  })
  menuToggle.onclick = () => {
    actions.hidden = !actions.hidden
    menuToggle.setAttribute('aria-expanded', String(!actions.hidden))
  }
  actions.addEventListener('click', (e) => {
    if (e.target.closest('button,a')) closeMenu()
  })
  viewer.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.viewer-menu')) closeMenu()
  })
  viewer.addEventListener('cancel', (e) => {
    if (!actions.hidden) {
      e.preventDefault()
      closeMenu()
      menuToggle.focus()
    }
  })
  let swipe = null
  media.addEventListener(
    'touchstart',
    (e) => {
      swipe =
        e.touches.length === 1 &&
        files[index]?.media_type !== 'video' &&
        (window.visualViewport?.scale ?? 1) === 1
          ? { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now(), index }
          : null
    },
    { passive: true },
  )
  media.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length !== 1) swipe = null
    },
    { passive: true },
  )
  media.addEventListener(
    'touchcancel',
    () => {
      swipe = null
    },
    { passive: true },
  )
  media.addEventListener(
    'touchend',
    (e) => {
      const start = swipe
      swipe = null
      if (
        !start ||
        start.index !== index ||
        !e.changedTouches.length ||
        (window.visualViewport?.scale ?? 1) !== 1
      )
        return
      const dx = e.changedTouches[0].clientX - start.x
      const dy = e.changedTouches[0].clientY - start.y
      if (Date.now() - start.time < 1000 && Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5)
        void show(index + (dx < 0 ? 1 : -1))
    },
    { passive: true },
  )
  async function loadMore() {
    if (nextPage === null) return
    if (loading) return loading
    loading = (async () => {
      loadingNotice.textContent = 'Loading photos…'
      failed = false
      try {
        const requestedPage = nextPage
        const data = await sharedJson(
          base + '?format=json&page=' + requestedPage,
          { cache: 'no-store', signal: lifetime.signal },
          isSharedPage,
          undefined,
          fetch,
        )
        if (data.nextPage !== null && data.nextPage <= requestedPage)
          throw Error('Invalid continuation')
        const ids = new Set(files.map((f) => f.photo_id))
        for (const p of data.items) {
          if (ids.has(p.photo_id)) continue
          ids.add(p.photo_id)
          const b = document.createElement('button')
          const img = document.createElement('img')
          b.className = 'photo-tile photo-tile-button'
          b.dataset.index = String(files.length)
          b.setAttribute('aria-label', 'Open ' + p.source_filename)
          img.alt = p.source_filename
          img.dataset.thumbnailState = 'deferred'
          img.dataset.thumbnailSrc = base + '/media/' + p.photo_id + '?kind=thumbnail'
          b.append(img)
          if (p.media_type === 'video')
            b.append(Object.assign(document.createElement('span'), { textContent: 'Video' }))
          files.push(p)
          grid.append(b)
        }
        nextPage = data.nextPage
        loadingNotice.textContent = ''
        if (viewer.open)
          document.getElementById('next').disabled = index === files.length - 1 && nextPage === null
      } catch {
        if (lifetime.signal.aborted) return
        failed = true
        loadingNotice.textContent = 'Unable to load photos. The link may have expired. '
        const retry = Object.assign(document.createElement('button'), { textContent: 'Retry' })
        retry.onclick = () => {
          failed = false
          void loadMore()
        }
        loadingNotice.append(retry)
      } finally {
        loading = null
        if (
          !lifetime.signal.aborted &&
          !failed &&
          nextPage !== null &&
          loadingNotice.getBoundingClientRect().top < innerHeight + 600
        )
          setTimeout(() => void loadMore(), 0)
      }
    })()
    return loading
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && !failed) void loadMore()
    },
    { rootMargin: '600px' },
  )
  observer.observe(loadingNotice)
  const imageBuffer = new ViewerImageBuffer()
  let navigation = 0
  const imageAt = (i) =>
    files[i]?.media_type === 'photo'
      ? { photoId: files[i].photo_id, url: base + '/media/' + files[i].photo_id + '?kind=display' }
      : null
  function windowImages(i) {
    return [i, i + 1, i + 2, i - 1].map(imageAt).filter(Boolean)
  }
  async function warmNeighbors(i, version) {
    if (
      version !== navigation ||
      !viewer.open ||
      document.hidden ||
      window.navigator?.connection?.saveData ||
      Date.now() >= expires
    )
      return
    if (i + 2 >= files.length && nextPage !== null) await loadMore()
    if (version !== navigation || !viewer.open || Date.now() >= expires) return
    const current = imageAt(i)
    const neighbors = [i + 1, i + 2, i - 1].map(imageAt).filter(Boolean)
    const allowed = preloadWindow(
      current ? imageBuffer.dimensions(current) : { photoId: -1, url: '', width: 0, height: 0 },
      neighbors.map((p) => imageBuffer.dimensions(p)),
    )
    imageBuffer.select(base, [...(current ? [current] : []), ...allowed])
    for (const p of allowed) imageBuffer.get(p, 'low')
  }
  let stream = null
  let playlistRequest = null
  function clearPlayer() {
    playlistRequest?.abort()
    playlistRequest = null
    if (stream) {
      stream.destroy()
      stream = null
    }
    media.replaceChildren()
  }
  async function show(i) {
    const version = ++navigation
    playlistRequest?.abort()
    if (i >= files.length && nextPage !== null) await loadMore()
    if (version !== navigation || i < 0 || i >= files.length) return
    closeMenu()
    index = i
    clearPlayer()
    document.dispatchEvent(
      new CustomEvent('shared-photo-change', { detail: { photoId: files[i].photo_id, base } }),
    )
    notice.textContent = ''
    const p = files[i]
    const source = base + '/media/' + p.photo_id
    imageBuffer.select(base, windowImages(i))
    const el =
      p.media_type === 'video'
        ? document.createElement('video')
        : imageBuffer.get(imageAt(i), 'high')
    if (p.media_type === 'video') {
      el.controls = true
      el.playsInline = true
      el.preload = 'auto'
    } else {
      el.alt = p.source_filename
      el.onload = () => void warmNeighbors(i, version)
    }
    el.onerror = () => {
      if (version === navigation && el.isConnected)
        notice.textContent = 'This media is unavailable, or the sharing link has expired.'
    }
    media.append(el)
    document.getElementById('previous').disabled = i === 0
    document.getElementById('next').disabled = i === files.length - 1 && nextPage === null
    const download = document.getElementById('download')
    if (download) download.href = source + '?kind=original'
    if (!viewer.open) viewer.showModal()
    if (p.media_type === 'video' || (el.complete && el.naturalWidth)) void warmNeighbors(i, version)
    if (p.media_type === 'video')
      try {
        const playlist = source + '?kind=playlist'
        const request = new AbortController()
        playlistRequest = request
        const status = await sharedRequest(
          playlist,
          { cache: 'no-store', signal: request.signal },
          async (r) => {
            await r.body?.cancel()
            return r.status
          },
          undefined,
          fetch,
        )
        if (version !== navigation || !viewer.open || !el.isConnected) return
        if (status === 204) {
          el.src = source + '?kind=display'
          return
        }
        if (el.canPlayType('application/vnd.apple.mpegurl')) el.src = playlist
        else if (window.Hls && Hls.isSupported()) {
          stream = new Hls({
            enableWorker: false,
            maxBufferLength: 20,
            maxMaxBufferLength: 30,
            backBufferLength: 5,
            maxBufferSize: 32 * 1024 * 1024,
          })
          stream.on(Hls.Events.ERROR, (_e, d) => {
            if (d.fatal && version === navigation && viewer.open)
              notice.textContent = 'Playback interrupted. Close and reopen this video to retry.'
          })
          stream.loadSource(playlist)
          stream.attachMedia(el)
        } else el.src = source + '?kind=display'
      } catch {
        if (version === navigation && viewer.open && el.isConnected)
          notice.textContent = 'This media is unavailable, or the sharing link has expired.'
      }
  }
  document.getElementById('grid').onclick = (e) => {
    const b = e.target.closest('button[data-index]')
    if (b) show(Number(b.dataset.index))
  }
  document.getElementById('close').onclick = async () => {
    if (document.fullscreenElement) await document.exitFullscreen()
    viewer.close()
  }
  viewer.onclose = () => {
    navigation++
    imageBuffer.clear()
    closeMenu()
    clearPlayer()
    document.dispatchEvent(new Event('shared-viewer-close'))
  }
  document.getElementById('previous').onclick = () => show(index - 1)
  document.getElementById('next').onclick = () => show(index + 1)
  document.getElementById('full').onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else if (viewer.requestFullscreen) await viewer.requestFullscreen()
      else notice.textContent = 'This browser is already using its largest available viewing area.'
    } catch {
      notice.textContent = 'Full screen is unavailable in this browser.'
    }
  }
  document.addEventListener('keydown', (e) => {
    if (viewer.open && !['INPUT', 'BUTTON', 'A'].includes(document.activeElement.tagName)) {
      if (e.key === 'ArrowRight') show(index + 1)
      if (e.key === 'ArrowLeft') show(index - 1)
    }
  })
  window.addEventListener('pagehide', () => {
    navigation++
    lifetime.abort()
    observer.disconnect()
    clearPlayer()
    imageBuffer.clear()
  })
  setInterval(() => {
    if (Date.now() >= expires) {
      navigation++
      lifetime.abort()
      observer.disconnect()
      clearPlayer()
      imageBuffer.clear()
      viewer.close()
      document.body.replaceChildren(
        Object.assign(document.createElement('p'), {
          textContent: 'This sharing link has expired.',
        }),
      )
    }
  }, 1000)

  return { show, loadMore, warmNeighbors, getVersion: () => navigation }
}
