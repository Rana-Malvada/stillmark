'use client'
import { useEffect, useRef, useState } from 'react'
import { createThumbnailLoader } from '@/public/thumbnail-loader.mjs'
import { createAppPreviewTransport } from '@/public/preview-batch-client.mjs'

let loader: ReturnType<typeof createThumbnailLoader> | undefined
export function Thumbnail({
  src,
  alt,
  className,
  fallbackSrc,
}: {
  src: string
  alt: string
  className?: string
  fallbackSrc?: string
}) {
  return (
    <ThumbnailImage key={src} src={src} alt={alt} className={className} fallbackSrc={fallbackSrc} />
  )
}
function ThumbnailImage({
  src,
  alt,
  className,
  fallbackSrc,
}: {
  src: string
  alt: string
  className?: string
  fallbackSrc?: string
}) {
  const [fallback, setFallback] = useState(false)
  const source = fallback && fallbackSrc ? fallbackSrc : src
  const image = useRef<HTMLImageElement>(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!image.current) return
    if (!loader) {
      loader = createThumbnailLoader(window, {
        previewBatch:
          document.documentElement.dataset.previewBatch === 'true'
            ? createAppPreviewTransport(window)
            : null,
      })
    }
    return loader.observe(image.current, source, (state: string) => {
      if (state === 'failed' && fallbackSrc && !fallback) setFallback(true)
      else setFailed(state === 'failed')
    })
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- retry is the manual re-observe trigger: the <img> remounts after a failure and must be observed again
  }, [source, retry, fallback, fallbackSrc])
  const restart = () => {
    setFailed(false)
    setRetry((value) => value + 1)
  }
  if (failed)
    return (
      <span
        role="button"
        tabIndex={0}
        aria-label={`Retry image: ${alt}`}
        title="Image unavailable. Retry image"
        className={`${className ?? ''} inline-flex items-center justify-center bg-muted text-xs cursor-pointer`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          restart()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            restart()
          }
        }}
      >
        ↻ Retry image
      </span>
    )
  return (
    <img
      ref={image}
      alt={alt}
      decoding="async"
      className={className}
      data-thumbnail-state="deferred"
    />
  )
}
