import type { ViewerImage } from '@/lib/viewer-image-buffer'
import { fetchBrowse } from '@/lib/fetch-browse'
import { readClientResponse } from '@/lib/client-response'

export interface PhotoDetail {
  preload?: ViewerImage[]
  canEdit: boolean
  isAlbumCover: boolean
  fileSizeBytes: number | null
  photoId: number
  eventId: number
  sourceFilename: string
  displayUrl: string | null
  originalUrl: string | null
  prev: number | null
  next: number | null
  favorite: boolean
  dateTaken: string | null
  cameraMake: string | null
  cameraModel: string | null
  lensModel: string | null
  lensMake: string | null
  lensSerial: string | null
  software: string | null
  artist: string | null
  copyright: string | null
  focalLength: string | null
  aperture: string | null
  shutterSpeed: string | null
  iso: number | null
  exposureCompensation: string | null
  flashUsed: boolean | null
  exposureProgram: string | null
  meteringMode: string | null
  lightSource: string | null
  whiteBalance: string | null
  exposureMode: string | null
  sceneCaptureType: string | null
  contrast: string | null
  saturation: string | null
  sharpness: string | null
  brightness: string | null
  focalLength35mm: string | null
  digitalZoomRatio: string | null
  colorSpace: string | null
  subjectDistanceRange: string | null
  width: number | null
  height: number | null
  city: string | null
  region: string | null
  country: string | null
  locationName: string | null
  locationManuallyAssigned?: boolean
  latitude: number | null
  longitude: number | null
  altitude: number | null
  gpsDirection: number | null
  gpsSpeed: number | null
  gpsTimestamp: string | null
  gpsHPositioningError: number | null
  iptcKeywords: string[] | null
  iptcHeadline: string | null
  iptcCopyright: string | null
  aiDescription: string | null
  caption: string | null
  userTags: string[]
  aiTags: string[] | null
  mediaType: string
  duration: number | null
}

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0
const strings = (v: unknown) => Array.isArray(v) && v.every((item) => typeof item === 'string')
export function isPhotoDetail(value: unknown): value is PhotoDetail {
  if (
    !record(value) ||
    !id(value.photoId) ||
    !id(value.eventId) ||
    typeof value.sourceFilename !== 'string' ||
    typeof value.canEdit !== 'boolean' ||
    typeof value.favorite !== 'boolean' ||
    typeof value.isAlbumCover !== 'boolean' ||
    typeof value.mediaType !== 'string' ||
    !['photo', 'video'].includes(value.mediaType)
  )
    return false
  if (!['prev', 'next'].every((key) => value[key] == null || id(value[key]))) return false
  const textFields = [
    'displayUrl',
    'originalUrl',
    'dateTaken',
    'cameraMake',
    'cameraModel',
    'lensModel',
    'lensMake',
    'lensSerial',
    'software',
    'artist',
    'copyright',
    'focalLength',
    'aperture',
    'shutterSpeed',
    'exposureCompensation',
    'exposureProgram',
    'meteringMode',
    'lightSource',
    'whiteBalance',
    'exposureMode',
    'sceneCaptureType',
    'contrast',
    'saturation',
    'sharpness',
    'brightness',
    'focalLength35mm',
    'digitalZoomRatio',
    'colorSpace',
    'subjectDistanceRange',
    'city',
    'region',
    'country',
    'locationName',
    'gpsTimestamp',
    'iptcHeadline',
    'iptcCopyright',
    'aiDescription',
    'caption',
  ]
  if (!textFields.every((key) => value[key] == null || typeof value[key] === 'string')) return false
  const numbers = [
    'fileSizeBytes',
    'iso',
    'width',
    'height',
    'latitude',
    'longitude',
    'altitude',
    'gpsDirection',
    'gpsSpeed',
    'gpsHPositioningError',
    'duration',
  ]
  if (
    !numbers.every(
      (key) =>
        value[key] == null || (typeof value[key] === 'number' && Number.isFinite(value[key])),
    )
  )
    return false
  if (
    !['flashUsed', 'locationManuallyAssigned'].every(
      (key) => value[key] == null || typeof value[key] === 'boolean',
    )
  )
    return false
  if (
    !['userTags', 'aiTags', 'iptcKeywords'].every(
      (key) => value[key] == null || strings(value[key]),
    )
  )
    return false
  if (value.dateTaken && !Number.isFinite(Date.parse(String(value.dateTaken)))) return false
  return (
    value.preload === undefined ||
    (Array.isArray(value.preload) &&
      value.preload.every(
        (item) =>
          record(item) &&
          id(item.photoId) &&
          typeof item.url === 'string' &&
          ['width', 'height'].every(
            (key) =>
              item[key] == null || (typeof item[key] === 'number' && Number.isFinite(item[key])),
          ),
      ))
  )
}
export async function loadPhotoDetail(id: number, context: string, signal: AbortSignal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(45000)])
  const response = await fetchBrowse(`/api/photos/${id}?${context}`, {
    cache: 'no-store',
    signal: bounded,
  })
  const photo = await readClientResponse(
    response,
    'Unable to load photo',
    (value): value is PhotoDetail => isPhotoDetail(value) && value.photoId === id,
  )
  bounded.throwIfAborted()
  return photo
}
