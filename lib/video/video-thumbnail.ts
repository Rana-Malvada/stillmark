function isBlackFrame(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const data = ctx.getImageData(0, 0, width, height).data
  let totalBrightness = 0
  let samples = 0
  for (let i = 0; i < data.length; i += 400) {
    totalBrightness += data[i] + data[i + 1] + data[i + 2]
    samples++
  }
  return samples > 0 && totalBrightness / samples < 30
}

export function generateVideoThumbnail(file: File, signal?: AbortSignal): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null)
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    video.autoplay = false

    const url = URL.createObjectURL(file)
    let resolved = false
    let captureTimer: ReturnType<typeof setTimeout> | undefined

    const done = (blob: Blob | null) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      clearTimeout(captureTimer)
      signal?.removeEventListener('abort', abort)
      video.onloadeddata = video.onseeked = video.onerror = null
      resolve(blob)
      URL.revokeObjectURL(url)
      try {
        video.pause()
        video.removeAttribute('src')
        video.load()
      } catch {
        // Decoder cleanup must not prevent the upload from continuing.
      }
    }

    const timeout = setTimeout(() => done(null), 20000)
    const abort = () => done(null)
    signal?.addEventListener('abort', abort, { once: true })

    const seekTimes = [2, 5, 10, 0.1]
    let seekIndex = 0

    const capture = () => {
      if (resolved) return
      try {
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, 400 / video.videoWidth)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

        if (isBlackFrame(ctx, canvas.width, canvas.height) && seekIndex < seekTimes.length) {
          const next = Math.min(seekTimes[seekIndex], video.duration * 0.5)
          seekIndex++
          video.currentTime = next
          return
        }

        // Keep the deadline active until toBlob actually calls back. Safari can
        // stall encoding even after seeking/decoding has succeeded.
        canvas.toBlob((blob) => done(blob), 'image/jpeg', 0.8)
      } catch {
        done(null)
      }
    }

    // Safari needs the video to play briefly to decode frames for canvas.
    // We play, wait for a timeupdate (proof a frame decoded), then pause + seek + capture.
    video.onloadeddata = () => {
      video
        .play()
        .then(() => {
          if (resolved) return
          const onTime = () => {
            video.removeEventListener('timeupdate', onTime)
            if (resolved) return
            video.pause()
            const target = Math.min(seekTimes[seekIndex], video.duration * 0.5)
            seekIndex++
            video.currentTime = target
          }
          video.addEventListener('timeupdate', onTime)
        })
        .catch(() => {
          if (resolved) return
          // play() rejected (e.g. autoplay policy) — fall back to seek-only
          const target = Math.min(seekTimes[seekIndex], video.duration * 0.5)
          seekIndex++
          video.currentTime = target
        })
    }

    video.onseeked = () => {
      // Give the decoder time to actually render the frame
      clearTimeout(captureTimer)
      captureTimer = setTimeout(capture, 300)
    }

    video.onerror = () => {
      done(null)
    }
    video.src = url
  })
}
