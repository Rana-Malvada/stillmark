// oxlint-disable-next-line import/newline-after-import -- the blank line is present; the rule misreads the leading semicolon
import { isSharedDetails, sharedJson } from './shared-album-transport.mjs'

;(() => {
  const panel = document.getElementById('details')
  const body = document.getElementById('details-body')
  const info = document.getElementById('info-toggle')
  const names = document.getElementById('names-toggle')
  const labels = document.getElementById('name-labels')
  const media = document.getElementById('media')
  let current = null
  let data = null
  let controller = null
  let showNames = false
  let zoom = 13
  const titles = {
    source_filename: 'Filename',
    ai_description: 'AI description',
    date_taken: 'Date taken',
    file_size_bytes: 'File size',
    camera_make: 'Camera make',
    camera_model: 'Camera',
    lens_model: 'Lens',
    focal_length: 'Focal length (mm)',
    focal_length_35mm: '35mm equivalent (mm)',
    shutter_speed: 'Shutter speed',
    duration: 'Duration (seconds)',
    altitude: 'Altitude (m)',
    iso: 'ISO',
  }
  function renderNames() {
    labels.replaceChildren()
    labels.hidden = !showNames
    if (!showNames || !data) return
    const img = media.querySelector('img')
    const people = data.people
    if (!people.length) {
      const message = document.createElement('div')
      message.className = 'name-list'
      message.textContent = 'No identified people in this photo.'
      labels.append(message)
      return
    }
    const list = []
    const imageBounds = img?.getBoundingClientRect()
    const bounds = labels.getBoundingClientRect()
    const scale = img?.naturalWidth
      ? Math.min(imageBounds.width / img.naturalWidth, imageBounds.height / img.naturalHeight)
      : 0
    const width = scale * (img?.naturalWidth || 0)
    const height = scale * (img?.naturalHeight || 0)
    for (const person of people) {
      const box = person.box
      if (!box || !scale) {
        list.push(person.name)
        continue
      }
      const label = document.createElement('div')
      const text = document.createElement('span')
      label.className = 'face-label'
      text.textContent = person.name
      Object.assign(label.style, {
        left:
          imageBounds.left - bounds.left + (imageBounds.width - width) / 2 + box.x * width + 'px',
        top:
          imageBounds.top - bounds.top + (imageBounds.height - height) / 2 + box.y * height + 'px',
        width: box.w * width + 'px',
        height: box.h * height + 'px',
      })
      label.append(text)
      labels.append(label)
    }
    if (list.length) {
      const el = document.createElement('div')
      el.className = 'name-list'
      el.textContent = [...new Set(list)].join(' · ')
      labels.append(el)
    }
  }
  function drawMap(map, latitude, longitude) {
    map.replaceChildren()
    const n = 2 ** zoom
    const lat = (Math.max(-85.0511, Math.min(85.0511, latitude)) * Math.PI) / 180
    const tx = ((longitude + 180) / 360) * n
    const ty = ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * n
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.floor(tx) + dx
        const y = Math.floor(ty) + dy
        if (y < 0 || y >= n) continue
        const tile = document.createElement('img')
        tile.alt = ''
        tile.onerror = () => {
          tile.hidden = true
          if (!map.querySelector('[role="status"]')) {
            const message = document.createElement('span')
            message.setAttribute('role', 'status')
            message.textContent = 'Map tiles unavailable. Open OpenStreetMap below.'
            Object.assign(message.style, {
              position: 'absolute',
              left: '8px',
              right: '8px',
              bottom: '28px',
              fontSize: '12px',
              background: 'var(--popover)',
              padding: '6px',
            })
            map.append(message)
          }
        }
        const cartoUrl = document.body.dataset.mapUrl
        tile.referrerPolicy = 'origin'
        tile.src = cartoUrl
          ? cartoUrl
              .replace('{z}', zoom)
              .replace('{x}', ((x % n) + n) % n)
              .replace('{y}', y)
          : current.base +
            '?asset=tile&photo=' +
            current.photoId +
            '&z=' +
            zoom +
            '&x=' +
            (((x % n) + n) % n) +
            '&y=' +
            y
        tile.style.left = `calc(50% + ${(x - tx) * 256}px)`
        tile.style.top = `calc(50% + ${(y - ty) * 256}px)`
        map.append(tile)
      }
    const pin = document.createElement('span')
    pin.className = 'pin'
    pin.setAttribute('aria-label', 'Photo location')
    map.append(pin)
    const controls = document.createElement('div')
    controls.className = 'zoom'
    for (const [text, step, label] of [
      ['+', 1, 'Zoom in'],
      ['−', -1, 'Zoom out'],
    ]) {
      const b = document.createElement('button')
      b.textContent = text
      b.setAttribute('aria-label', label)
      b.disabled = zoom + step < 1 || zoom + step > 19
      b.onclick = () => {
        zoom += step
        drawMap(map, latitude, longitude)
      }
      controls.append(b)
    }
    map.append(controls)
    const attribution = document.createElement('a')
    attribution.className = 'attribution'
    attribution.textContent = '© OpenStreetMap'
    attribution.href =
      'https://www.openstreetmap.org/?mlat=' +
      latitude +
      '&mlon=' +
      longitude +
      '#map=' +
      zoom +
      '/' +
      latitude +
      '/' +
      longitude
    attribution.target = '_blank'
    attribution.rel = 'noreferrer noopener'
    map.append(attribution)
    if (document.body.dataset.mapUrl) {
      const carto = document.createElement('a')
      carto.textContent = ' · © CARTO'
      carto.href = 'https://carto.com/attribution/'
      carto.target = '_blank'
      carto.rel = 'noreferrer noopener'
      const credits = document.createElement('span')
      credits.className = 'attribution'
      attribution.className = ''
      credits.append(attribution, carto)
      map.append(credits)
    }
  }
  function renderDetails() {
    if (panel.hidden || !data) return
    body.replaceChildren()
    const dl = document.createElement('dl')
    for (const [key, value] of Object.entries(data.details)) {
      if (value === null || value === '') continue
      const dt = document.createElement('dt')
      const dd = document.createElement('dd')
      dt.textContent = titles[key] || key.replaceAll('_', ' ')
      dd.textContent =
        key === 'file_size_bytes'
          ? (Number(value) / 1048576).toFixed(1) + ' MB'
          : key === 'date_taken'
            ? new Date(value).toLocaleString()
            : typeof value === 'boolean'
              ? value
                ? 'Yes'
                : 'No'
              : String(value)
      if (key === 'ai_description') dd.style.whiteSpace = 'pre-wrap'
      dl.append(dt, dd)
    }
    if (data.people.length) {
      const dt = document.createElement('dt')
      const dd = document.createElement('dd')
      dt.textContent = 'People'
      dd.textContent = [...new Set(data.people.map((p) => p.name))].join(', ')
      dl.append(dt, dd)
    }
    body.append(dl)
    const { latitude, longitude } = data.details
    if (
      latitude != null &&
      longitude != null &&
      Number.isFinite(Number(latitude)) &&
      Number.isFinite(Number(longitude))
    ) {
      const map = document.createElement('div')
      map.id = 'gps-map'
      map.setAttribute('role', 'region')
      map.setAttribute('aria-label', 'Photo GPS map')
      body.append(map)
      drawMap(map, Number(latitude), Number(longitude))
    }
  }
  async function load() {
    if (!current || (panel.hidden && !showNames)) return
    if (data) {
      renderDetails()
      renderNames()
      return
    }
    controller?.abort()
    const request = new AbortController()
    controller = request
    body.textContent = 'Loading details…'
    try {
      const result = await sharedJson(
        current.base + '?photo=' + current.photoId,
        {
          signal: request.signal,
          cache: 'no-store',
        },
        isSharedDetails,
      )
      if (request.signal.aborted || controller !== request) return
      data = result
      renderDetails()
      renderNames()
    } catch {
      if (!request.signal.aborted && controller === request) {
        body.textContent =
          'Details unavailable. The link may have expired. Close and reopen Info to retry.'
        labels.replaceChildren()
      }
    }
  }
  info.onclick = () => {
    panel.hidden = !panel.hidden
    info.setAttribute('aria-expanded', String(!panel.hidden))
    if (panel.hidden && !showNames) controller?.abort()
    void load()
  }
  const expand = document.getElementById('details-expand')
  if (expand)
    expand.onclick = () => {
      const expanded = panel.classList.toggle('expanded')
      expand.setAttribute('aria-expanded', String(expanded))
      expand.textContent = expanded ? 'Reduce' : 'Expand'
    }
  document.getElementById('details-close').onclick = () => {
    panel.hidden = true
    if (!showNames) controller?.abort()
    info.setAttribute('aria-expanded', 'false')
    info.focus()
  }
  if (names)
    names.onclick = () => {
      showNames = !showNames
      names.querySelector('span').textContent = showNames ? 'Hide names' : 'Show names'
      names.setAttribute('aria-pressed', String(showNames))
      renderNames()
      void load()
    }
  document.addEventListener('shared-photo-change', (event) => {
    controller?.abort()
    current = event.detail
    data = null
    zoom = 13
    labels.replaceChildren()
    void load()
  })
  document.addEventListener('shared-viewer-close', () => {
    controller?.abort()
    current = null
    data = null
    labels.replaceChildren()
    panel.hidden = true
    if (!showNames) controller?.abort()
    info.setAttribute('aria-expanded', 'false')
  })
  media.addEventListener('load', renderNames, true)
  new ResizeObserver(renderNames).observe(media)
})()
