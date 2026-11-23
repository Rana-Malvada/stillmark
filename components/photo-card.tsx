import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Thumbnail } from './thumbnail'

interface PhotoCardProps extends Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onClick' | 'disabled' | 'aria-label' | 'aria-pressed'
> {
  thumbnailUrl?: string | null
  filename: string
  alt?: string
  selected?: boolean
  children?: ReactNode
  footer?: ReactNode
}
export function PhotoCard({
  thumbnailUrl,
  filename,
  alt,
  selected,
  children,
  footer,
  ...button
}: PhotoCardProps) {
  return (
    <div className={`photo-card photo-tile ${selected ? 'ring-2 ring-primary' : ''}`}>
      <button
        {...button}
        type="button"
        className="photo-tile-button focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-primary disabled:cursor-wait"
      >
        {thumbnailUrl ? (
          <Thumbnail src={thumbnailUrl} alt={alt || filename} className="h-full w-full" />
        ) : (
          <div className="h-full w-full bg-muted p-4 text-xs break-all">{filename}</div>
        )}
        {children}
      </button>
      {footer}
    </div>
  )
}
