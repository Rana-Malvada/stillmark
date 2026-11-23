import { beforeEach, describe, expect, it, vi } from 'vitest'

const database = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  calls: [] as { sql: string; values: unknown[] }[],
}))
vi.mock('@/lib/postgres', () => ({
  pgQueryOne: async (sql: string, values: unknown[]) => {
    database.calls.push({ sql, values })
    return sql.startsWith('INSERT') ? { photo_id: 41 } : database.row
  },
  pgQuery: vi.fn(),
  pgTransaction: vi.fn(),
  pgReadIdentity: vi.fn(),
}))
vi.mock('@/lib/albums/album-access', () => ({ canEditAlbum: vi.fn() }))
vi.mock('@/lib/database/management-lock', () => ({ lockManagement: vi.fn() }))

import { getPhoto, insertPhoto, type NewPhoto, PHOTO_COLUMNS } from '@/lib/photos'

beforeEach(() => {
  database.row = null
  database.calls.length = 0
})

/**
 * The INSERT as it was written by hand before the column table existed: each column with
 * the parameter it was bound to. Written out literally so a table edit cannot change the
 * statement unnoticed.
 */
const INSERTED: [column: string, value: unknown, cast?: string][] = [
  ['event_id', 12],
  ['source_filename', 'IMG_0001.JPG'],
  ['source_relative_path', 'Trip/IMG_0001.JPG'],
  ['original_stage_path', 'originals/12/abc.jpg'],
  ['file_size_bytes', 123456],
  ['content_type', 'image/jpeg'],
  ['file_extension', 'jpg'],
  ['file_hash', 'hash-1'],
  ['width', 4000],
  ['height', 3000],
  ['aspect_ratio', 1.3333],
  ['orientation', 6],
  ['date_taken', '2024-05-06T07:08:09.000Z'],
  ['camera_make', 'Make'],
  ['camera_model', 'Model'],
  ['lens_model', 'Lens model'],
  ['lens_make', 'Lens make'],
  ['lens_serial', 'Lens serial'],
  ['software', 'Software'],
  ['artist', 'Artist'],
  ['copyright', 'Copyright'],
  ['focal_length', '35'],
  ['aperture', '2.8'],
  ['shutter_speed', '0.004'],
  ['iso', 200],
  ['exposure_compensation', '-0.3'],
  ['flash_used', false],
  ['exposure_program', 'Aperture priority'],
  ['metering_mode', 'Pattern'],
  ['light_source', 'Daylight'],
  ['white_balance', 'Auto'],
  ['exposure_mode', 'Manual'],
  ['scene_capture_type', 'Landscape'],
  ['contrast', 'Normal'],
  ['saturation', 'High'],
  ['sharpness', 'Soft'],
  ['brightness', '5.5'],
  ['focal_length_35mm', '52'],
  ['digital_zoom_ratio', '1'],
  ['color_space', 'sRGB'],
  ['subject_distance_range', 'Distant'],
  ['latitude', 47.6],
  ['longitude', -122.3],
  ['altitude', 56.7],
  ['gps_direction', 181.5],
  ['gps_speed', 3.2],
  ['gps_timestamp', '2024-05-06T07:08:00.000Z'],
  ['gps_h_positioning_error', 4.5],
  ['iptc_keywords', ['one', 'two']],
  ['iptc_headline', 'Headline'],
  ['iptc_copyright', 'IPTC copyright'],
  ['date_taken_raw', '2024:05:06 07:08:09'],
  ['exif_raw', '{"exif":1}', 'jsonb'],
  ['xmp_raw', '{"xmp":1}', 'jsonb'],
  ['iptc_raw', '{"iptc":1}', 'jsonb'],
  ['icc_raw', '{"icc":1}', 'jsonb'],
  ['ingest_status', 'PROCESSING'],
  ['media_type', 'video'],
  ['duration', 12.5],
]

const newPhoto: NewPhoto = {
  eventId: 12,
  sourceFilename: 'IMG_0001.JPG',
  sourceRelativePath: 'Trip/IMG_0001.JPG',
  originalStagePath: 'originals/12/abc.jpg',
  fileSizeBytes: 123456,
  contentType: 'image/jpeg',
  fileExtension: 'jpg',
  fileHash: 'hash-1',
  width: 4000,
  height: 3000,
  aspectRatio: 1.3333,
  orientation: 6,
  dateTaken: '2024-05-06T07:08:09.000Z',
  cameraMake: 'Make',
  cameraModel: 'Model',
  lensModel: 'Lens model',
  lensMake: 'Lens make',
  lensSerial: 'Lens serial',
  software: 'Software',
  artist: 'Artist',
  copyright: 'Copyright',
  focalLength: '35',
  aperture: '2.8',
  shutterSpeed: '0.004',
  iso: 200,
  exposureCompensation: '-0.3',
  flashUsed: false,
  exposureProgram: 'Aperture priority',
  meteringMode: 'Pattern',
  lightSource: 'Daylight',
  whiteBalance: 'Auto',
  exposureMode: 'Manual',
  sceneCaptureType: 'Landscape',
  contrast: 'Normal',
  saturationVal: 'High',
  sharpnessVal: 'Soft',
  brightness: '5.5',
  focalLength35mm: '52',
  digitalZoomRatio: '1',
  colorSpace: 'sRGB',
  subjectDistanceRange: 'Distant',
  latitude: 47.6,
  longitude: -122.3,
  altitude: 56.7,
  gpsDirection: 181.5,
  gpsSpeed: 3.2,
  gpsTimestamp: '2024-05-06T07:08:00.000Z',
  gpsHPositioningError: 4.5,
  iptcKeywords: ['one', 'two'],
  iptcHeadline: 'Headline',
  iptcCopyright: 'IPTC copyright',
  dateTakenRaw: '2024:05:06 07:08:09',
  exifRaw: '{"exif":1}',
  xmpRaw: '{"xmp":1}',
  iptcRaw: '{"iptc":1}',
  iccRaw: '{"icc":1}',
  ingestStatus: 'PROCESSING',
  mediaType: 'video',
  duration: 12.5,
}

const withoutWhitespace = (sql: string) => sql.replace(/\s+/g, '')

describe('insertPhoto', () => {
  it('sends the same columns, casts and values as the hand-written statement', async () => {
    expect(await insertPhoto(newPhoto)).toBe(41)
    expect(database.calls).toHaveLength(1)
    const [{ sql, values }] = database.calls
    const columns = INSERTED.map(([column]) => column).join(',')
    const placeholders = INSERTED.map(
      ([, , cast], index) => `$${index + 1}${cast ? `::${cast}` : ''}`,
    ).join(',')
    expect(withoutWhitespace(sql)).toBe(
      `INSERTINTOphotos(${columns})VALUES(${placeholders})RETURNINGphoto_id`,
    )
    expect(values).toEqual(INSERTED.map(([, value]) => value))
    expect(values).toHaveLength(59)
  })

  it('stores a still photo with no duration when media type and duration are omitted', async () => {
    const { mediaType: _mediaType, duration: _duration, ...still } = newPhoto
    await insertPhoto(still)
    const { values } = database.calls[0]
    expect(values.slice(-3)).toEqual(['PROCESSING', 'photo', null])
    await insertPhoto({ ...still, duration: null })
    expect(database.calls[1].values.slice(-3)).toEqual(['PROCESSING', 'photo', null])
  })
})

describe('photo row mapping', () => {
  it('converts a fully populated row exactly as the hand-written mapper did', async () => {
    database.row = {
      photo_id: '101',
      event_id: '12',
      source_filename: 'IMG_0001.JPG',
      source_relative_path: 'Trip/IMG_0001.JPG',
      original_stage_path: 'originals/12/abc.jpg',
      display_stage_path: 'display/12/abc.webp',
      thumbnail_stage_path: 'thumb/12/abc.webp',
      file_size_bytes: '123456',
      content_type: 'image/jpeg',
      file_extension: 'jpg',
      file_hash: 'hash-1',
      width: 4000,
      height: 3000,
      aspect_ratio: '1.3333',
      orientation: 6,
      date_taken: new Date('2024-05-06T07:08:09.000Z'),
      camera_make: 'Make',
      camera_model: 'Model',
      lens_model: 'Lens model',
      lens_make: 'Lens make',
      lens_serial: 'Lens serial',
      software: 'Software',
      artist: 'Artist',
      copyright: 'Copyright',
      focal_length: 35,
      aperture: 2.8,
      shutter_speed: '0.004',
      iso: '200',
      exposure_compensation: '-0.3',
      flash_used: false,
      exposure_program: 'Aperture priority',
      metering_mode: 'Pattern',
      light_source: 'Daylight',
      white_balance: 'Auto',
      exposure_mode: 'Manual',
      scene_capture_type: 'Landscape',
      contrast: 'Normal',
      saturation: 'High',
      sharpness: 'Soft',
      brightness: '5.5',
      focal_length_35mm: '52',
      digital_zoom_ratio: '1',
      color_space: 'sRGB',
      subject_distance_range: 'Distant',
      location_assignment_id: 9,
      latitude: '47.6',
      longitude: '-122.3',
      altitude: '56.7',
      gps_direction: '181.5',
      gps_speed: '3.2',
      gps_timestamp: '2024-05-06 07:08:00+00',
      gps_h_positioning_error: '4.5',
      country: 'Country',
      region: 'Region',
      city: 'City',
      location_name: 'Place',
      iptc_keywords: ['one', 2],
      iptc_headline: 'Headline',
      iptc_copyright: 'IPTC copyright',
      date_taken_raw: '2024:05:06 07:08:09',
      exif_raw: { exif: 1 },
      xmp_raw: { xmp: 1 },
      iptc_raw: { iptc: 1 },
      icc_raw: { icc: 1 },
      caption: 'Caption',
      user_tags: ['tag', 7],
      ai_description: 'Described',
      ai_tags: ['ai', 3],
      favorite: true,
      rating: '4',
      ingest_status: 'READY',
      ingest_error: 'Earlier failure',
      media_type: 'video',
      duration: '12.5',
      created_at: new Date('2024-05-07T00:00:00.000Z'),
      album_owner: 'someone',
    }
    expect(await getPhoto(101)).toStrictEqual({
      photoId: 101,
      eventId: 12,
      sourceFilename: 'IMG_0001.JPG',
      originalStagePath: 'originals/12/abc.jpg',
      displayStagePath: 'display/12/abc.webp',
      thumbnailStagePath: 'thumb/12/abc.webp',
      fileSizeBytes: 123456,
      contentType: 'image/jpeg',
      fileExtension: 'jpg',
      fileHash: 'hash-1',
      width: 4000,
      height: 3000,
      aspectRatio: 1.3333,
      orientation: 6,
      dateTaken: '2024-05-06T07:08:09.000Z',
      cameraMake: 'Make',
      cameraModel: 'Model',
      lensModel: 'Lens model',
      lensMake: 'Lens make',
      lensSerial: 'Lens serial',
      software: 'Software',
      artist: 'Artist',
      copyright: 'Copyright',
      focalLength: '35',
      aperture: '2.8',
      shutterSpeed: '0.004',
      iso: 200,
      exposureCompensation: '-0.3',
      flashUsed: false,
      exposureProgram: 'Aperture priority',
      meteringMode: 'Pattern',
      lightSource: 'Daylight',
      whiteBalance: 'Auto',
      exposureMode: 'Manual',
      sceneCaptureType: 'Landscape',
      contrast: 'Normal',
      saturation: 'High',
      sharpness: 'Soft',
      brightness: '5.5',
      focalLength35mm: '52',
      digitalZoomRatio: '1',
      colorSpace: 'sRGB',
      subjectDistanceRange: 'Distant',
      locationManuallyAssigned: true,
      latitude: 47.6,
      longitude: -122.3,
      altitude: 56.7,
      gpsDirection: 181.5,
      gpsSpeed: 3.2,
      gpsTimestamp: '2024-05-06 07:08:00+00',
      gpsHPositioningError: 4.5,
      country: 'Country',
      region: 'Region',
      city: 'City',
      locationName: 'Place',
      iptcKeywords: ['one', '2'],
      iptcHeadline: 'Headline',
      iptcCopyright: 'IPTC copyright',
      exifRaw: { exif: 1 },
      xmpRaw: { xmp: 1 },
      iptcRaw: { iptc: 1 },
      iccRaw: { icc: 1 },
      caption: 'Caption',
      userTags: ['tag', '7'],
      aiDescription: 'Described',
      aiTags: ['ai', '3'],
      favorite: true,
      rating: 4,
      ingestStatus: 'READY',
      ingestError: 'Earlier failure',
      mediaType: 'video',
      duration: 12.5,
    })
  })

  it('fills the hand-written defaults for a row that has only its required columns', async () => {
    database.row = { photo_id: 7, event_id: 3, source_filename: 'bare.jpg', iso: 0, width: 0 }
    const photo = await getPhoto(7)
    const nullProperties = PHOTO_COLUMNS.flatMap((column) =>
      'property' in column ? [column.property] : [],
    ).filter(
      (property) =>
        ![
          'photoId',
          'eventId',
          'sourceFilename',
          'iso',
          'width',
          'locationManuallyAssigned',
          'userTags',
          'favorite',
          'ingestStatus',
          'mediaType',
        ].includes(property),
    )
    expect(nullProperties).toHaveLength(62)
    expect(photo).toStrictEqual({
      ...Object.fromEntries(nullProperties.map((property) => [property, null])),
      photoId: 7,
      eventId: 3,
      sourceFilename: 'bare.jpg',
      iso: 0,
      width: 0,
      locationManuallyAssigned: false,
      userTags: [],
      favorite: false,
      ingestStatus: 'DISCOVERED',
      mediaType: 'photo',
    })
  })

  it('treats empty text as absent but keeps a false flash flag', async () => {
    database.row = {
      photo_id: 8,
      event_id: 3,
      source_filename: 'empty.jpg',
      caption: '',
      camera_make: '',
      date_taken: '',
      flash_used: false,
      rating: 0,
      iptc_keywords: 'not-an-array',
      exif_raw: undefined,
    }
    const photo = await getPhoto(8)
    expect(photo).toMatchObject({
      caption: null,
      cameraMake: null,
      dateTaken: null,
      flashUsed: false,
      rating: 0,
      iptcKeywords: null,
      exifRaw: null,
    })
  })
})

describe('photo column table', () => {
  it('names every column and every property once', () => {
    const columns = PHOTO_COLUMNS.map((column) => column.column)
    const properties = PHOTO_COLUMNS.flatMap((column) =>
      'property' in column ? [column.property] : [],
    )
    expect(new Set(columns).size).toBe(columns.length)
    expect(new Set(properties).size).toBe(properties.length)
    expect(properties).toHaveLength(72)
  })
})
