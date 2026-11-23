import Link from 'next/link'
import { format } from 'date-fns'
import type { ReactNode } from 'react'
import type { PhotoDetail } from './photo-detail-data'

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <dl className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-3 py-1.5 text-xs leading-relaxed">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 break-words text-foreground">{value}</dd>
    </dl>
  )
}
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4 rounded-xl border border-border bg-foreground/[0.03] p-4">
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  )
}

export function PhotoMetadata({ photo, onShowMap }: { photo: PhotoDetail; onShowMap: () => void }) {
  const locationParts = [photo.locationName, photo.city, photo.region, photo.country].filter(
    Boolean,
  )
  const locationStr = locationParts.join(', ')

  const formatShutter = (s: string | null) => {
    if (!s) return null
    const val = parseFloat(s)
    if (val >= 1) return `${val}s`
    return `1/${Math.round(1 / val)}`
  }

  const techLine = [
    photo.focalLength ? `${Math.round(parseFloat(photo.focalLength))}mm` : null,
    photo.aperture ? `f/${parseFloat(photo.aperture).toFixed(1)}` : null,
    formatShutter(photo.shutterSpeed),
    photo.iso ? `ISO ${photo.iso}` : null,
  ]
    .filter(Boolean)
    .join(' \u00B7 ')

  return (
    <>
      {(locationStr || photo.latitude != null || photo.dateTaken) && (
        <DetailSection title="Date & location">
          {photo.locationManuallyAssigned && (
            <p className="text-xs text-primary mb-2">Manually assigned location · approximate</p>
          )}
          {locationStr && <p className="text-base mb-1">{locationStr}</p>}
          {photo.latitude != null && photo.longitude != null && (
            <button
              onClick={onShowMap}
              className="my-2 min-h-11 w-full rounded-lg border border-border bg-foreground/5 px-3 py-2 text-left text-xs text-primary hover:bg-foreground/10"
            >
              <span className="mb-1 block font-medium">View location on map</span>
              {photo.latitude.toFixed(6)}, {photo.longitude.toFixed(6)}
              {photo.altitude != null ? ` · ${Math.round(photo.altitude)}m` : ''}
            </button>
          )}
          {photo.dateTaken && (
            <InfoRow
              label="Captured"
              value={format(new Date(photo.dateTaken), 'MMM d, yyyy · h:mm a')}
            />
          )}
        </DetailSection>
      )}
      {photo.aiDescription && (
        <DetailSection title="AI description">
          <p className="text-sm text-foreground/80 leading-relaxed">{photo.aiDescription}</p>
        </DetailSection>
      )}

      {photo.caption && (
        <DetailSection title="Caption">
          <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">
            {photo.caption}
          </p>
        </DetailSection>
      )}
      {!!photo.userTags?.length && (
        <DetailSection title="Your tags">
          <div className="flex flex-wrap gap-1">
            {photo.userTags.map((tag) => (
              <Link
                key={tag}
                href={`/search?q=${encodeURIComponent(tag)}`}
                className="text-xs bg-foreground/10 hover:bg-foreground/20 rounded px-2 py-1 break-all"
              >
                {tag}
              </Link>
            ))}
          </div>
        </DetailSection>
      )}
      {(photo.cameraMake ||
        photo.cameraModel ||
        photo.lensModel ||
        photo.lensMake ||
        techLine ||
        photo.focalLength35mm ||
        photo.exposureCompensation) && (
        <DetailSection title="Camera & lens">
          {(photo.cameraMake || photo.cameraModel) && (
            <InfoRow
              label="Camera"
              value={[photo.cameraMake, photo.cameraModel].filter(Boolean).join(' ')}
            />
          )}
          {photo.lensModel && <InfoRow label="Lens" value={photo.lensModel} />}
          {photo.lensMake && photo.lensMake !== photo.cameraMake && (
            <InfoRow label="Lens maker" value={photo.lensMake} />
          )}
          {techLine && (
            <p className="mt-3 rounded-lg bg-foreground/5 p-3 text-sm font-medium leading-relaxed text-foreground/90">
              {techLine}
            </p>
          )}
          {photo.focalLength35mm && (
            <InfoRow
              label="35mm equivalent"
              value={`${Math.round(parseFloat(photo.focalLength35mm))}mm`}
            />
          )}
          {photo.exposureCompensation && photo.exposureCompensation !== '0' && (
            <InfoRow
              label="Exposure compensation"
              value={`${parseFloat(photo.exposureCompensation) > 0 ? '+' : ''}${photo.exposureCompensation}`}
            />
          )}
        </DetailSection>
      )}
      {(photo.exposureProgram ||
        photo.exposureMode ||
        photo.meteringMode ||
        photo.whiteBalance ||
        photo.sceneCaptureType ||
        photo.flashUsed != null) && (
        <DetailSection title="Capture settings">
          {photo.exposureProgram && <InfoRow label="Program" value={photo.exposureProgram} />}
          {photo.exposureMode && <InfoRow label="Exposure Mode" value={photo.exposureMode} />}
          {photo.meteringMode && <InfoRow label="Metering" value={photo.meteringMode} />}
          {photo.whiteBalance && <InfoRow label="White Balance" value={photo.whiteBalance} />}
          {photo.lightSource && <InfoRow label="Light Source" value={photo.lightSource} />}
          {photo.sceneCaptureType && <InfoRow label="Scene" value={photo.sceneCaptureType} />}
          {photo.flashUsed != null && (
            <InfoRow label="Flash" value={photo.flashUsed ? 'Fired' : 'No flash'} />
          )}
          {photo.brightness && (
            <InfoRow label="Brightness" value={parseFloat(photo.brightness).toFixed(2)} />
          )}
          {photo.contrast && <InfoRow label="Contrast" value={photo.contrast} />}
          {photo.saturation && <InfoRow label="Saturation" value={photo.saturation} />}
          {photo.sharpness && <InfoRow label="Sharpness" value={photo.sharpness} />}
          {photo.colorSpace && (
            <InfoRow
              label="Color Space"
              value={
                photo.colorSpace === '65535'
                  ? 'Uncalibrated'
                  : photo.colorSpace === '1'
                    ? 'sRGB'
                    : photo.colorSpace
              }
            />
          )}
          {photo.digitalZoomRatio &&
            photo.digitalZoomRatio !== '1' &&
            photo.digitalZoomRatio !== '0' && (
              <InfoRow
                label="Digital Zoom"
                value={`${parseFloat(photo.digitalZoomRatio).toFixed(1)}x`}
              />
            )}
        </DetailSection>
      )}

      {photo.aiTags && photo.aiTags.length > 0 && (
        <div className="mt-4 rounded-xl border border-border bg-foreground/[0.03] p-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            AI tags
          </h4>
          <div className="flex flex-wrap gap-1">
            {photo.aiTags.map((tag, i) => (
              <span key={i} className="text-xs bg-primary/20 text-primary rounded px-2 py-0.5">
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {photo.iptcKeywords && photo.iptcKeywords.length > 0 && (
        <div className="mt-4 rounded-xl border border-border bg-foreground/[0.03] p-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Embedded keywords
          </h4>
          <div className="flex flex-wrap gap-1">
            {photo.iptcKeywords.map((kw, i) => (
              <span key={i} className="text-xs bg-foreground/10 rounded px-2 py-0.5">
                {kw}
              </span>
            ))}
          </div>
        </div>
      )}

      <DetailSection title="File information">
        <InfoRow label="Filename" value={photo.sourceFilename} />
        {photo.iptcHeadline && <InfoRow label="Headline" value={photo.iptcHeadline} />}
        {photo.fileSizeBytes != null && (
          <InfoRow
            label="File size"
            value={`${(photo.fileSizeBytes / 1024 / 1024).toFixed(1)} MB`}
          />
        )}
        {photo.width && photo.height && (
          <InfoRow label="Dimensions" value={`${photo.width} × ${photo.height}`} />
        )}

        {(photo.artist || photo.copyright || photo.software) && (
          <div className="mt-3 space-y-1">
            {photo.artist && <InfoRow label="Artist" value={photo.artist} />}
            {photo.copyright && <InfoRow label="Copyright" value={photo.copyright} />}
            {photo.software && <InfoRow label="Software" value={photo.software} />}
          </div>
        )}
      </DetailSection>
    </>
  )
}
