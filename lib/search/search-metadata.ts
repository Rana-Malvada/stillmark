// Only searchable catalog fields belong here. SQL identifiers come from this list.
const photoText =
  'source_filename file_extension content_type file_hash camera_make camera_model lens_make lens_model lens_serial software artist copyright exposure_program metering_mode light_source white_balance exposure_mode scene_capture_type contrast saturation sharpness brightness focal_length focal_length_35mm aperture shutter_speed exposure_compensation color_space digital_zoom_ratio subject_distance_range country region city location_name caption ai_description iptc_headline iptc_copyright media_type'
const photoNumbers =
  'photo_id file_size_bytes width height aspect_ratio orientation iso latitude longitude altitude gps_direction gps_speed gps_h_positioning_error rating duration'
type Kind = 'text' | 'number' | 'boolean' | 'date' | 'tags'
export const metadataFields = new Map<
  string,
  { column: string; kind: Kind; unit?: string; description?: string }
>()
function add(names: string, kind: Kind, table = 'p', prefix = '') {
  for (const name of names.split(' '))
    metadataFields.set(prefix + name, { column: table + '.' + name, kind })
}
add(photoText, 'text')
add(photoNumbers, 'number')
add('flash_used favorite', 'boolean')
add('date_taken created_at updated_at gps_timestamp', 'date')
add('ai_tags user_tags iptc_keywords', 'tags')
add('exif_raw iptc_raw xmp_raw icc_raw', 'text')
add('event_name location visibility owner_username source_folder', 'text', 'e', 'album_')
add('event_id event_year event_month photo_count', 'number', 'e', 'album_')
add('created_at updated_at', 'date', 'e', 'album_')
metadataFields.set('location_manually_assigned', {
  kind: 'boolean',
  column: '(p.location_assignment_id IS NOT NULL)',
})
metadataFields.set('album_folder', {
  kind: 'text',
  column: '(SELECT folder_name FROM folders WHERE folder_id=e.folder_id)',
  description:
    'The user-visible folder containing the album. Use this for folder names; not album_source_folder.',
})
metadataFields.set('ocr_text', {
  kind: 'text',
  column:
    "(SELECT ocr_text FROM search_enrichment WHERE photo_id=p.photo_id AND source_path=p.original_stage_path AND status='completed')",
})
metadataFields.set('video_analysis', {
  kind: 'text',
  column:
    "(SELECT search_text FROM video_analyses WHERE photo_id=p.photo_id AND status='completed' ORDER BY created_at DESC LIMIT 1)",
})
metadataFields.set('descriptive_text', {
  kind: 'text',
  column: `nullif(trim(concat_ws(' ',
    p.ai_description,p.caption,
    array_to_string(p.ai_tags,' '),
    array_to_string(p.user_tags,' '),
    array_to_string(p.iptc_keywords,' '),
    ${metadataFields.get('ocr_text')!.column},
    ${metadataFields.get('video_analysis')!.column})), '')`,
  description:
    'Recorded descriptions, captions, tags, OCR and video analysis of this photo. matches uses word stems (mountain/mountains), not literal substrings. Missing evidence is unknown, not evidence of absence. Excludes album names, geographic labels and identities.',
})
export type MetadataFilter = { field: string; op: string; value: string | number | boolean }
const operators: Record<Kind, readonly string[]> = {
  text: ['equals', 'contains', 'matches', 'starts_with', 'ends_with', 'missing', 'exists'],
  tags: ['equals', 'contains', 'missing', 'exists'],
  number: ['equals', 'lt', 'lte', 'gt', 'gte', 'missing', 'exists'],
  date: ['equals', 'lt', 'lte', 'gt', 'gte', 'missing', 'exists'],
  boolean: ['equals', 'missing', 'exists'],
}
export function validFilter(f: unknown): f is MetadataFilter {
  if (!f || typeof f !== 'object') return false
  const { field, op } = f as MetadataFilter
  let { value } = f as MetadataFilter
  const spec = metadataFields.get(field)
  if (typeof value === 'number' && spec?.kind === 'number' && Number.isFinite(value))
    value = String(value)
  if (typeof value === 'boolean' && spec?.kind === 'boolean') value = String(value)
  if (
    !spec ||
    !operators[spec.kind].includes(op) ||
    typeof value !== 'string' ||
    value.length > 200
  )
    return false
  if (op === 'missing' || op === 'exists') return value === ''
  if (!value.trim()) return false
  if (spec.kind === 'number')
    return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(Number(value))
  if (spec.kind === 'boolean') return ['true', 'false'].includes(value)
  if (spec.kind === 'date')
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value
    )
  return true
}
export function metadataClause(f: MetadataFilter, bind: (value: unknown, type: string) => string) {
  if (!validFilter(f)) throw Error('Invalid search metadata filter')
  const { kind, column } = metadataFields.get(f.field)!
  if (f.op === 'missing' || f.op === 'exists') {
    const missing =
      kind === 'tags'
        ? `coalesce(cardinality(${column}),0)=0`
        : kind === 'text'
          ? `nullif(trim(${column}::text),'') IS NULL`
          : `${column} IS NULL`
    return f.op === 'missing' ? `(${missing})` : `NOT (${missing})`
  }
  if (kind === 'tags')
    return `EXISTS(SELECT FROM unnest(${column}) tag WHERE lower(trim(tag))=lower(${bind(f.value, 'text')}))`
  if (kind === 'text') {
    const param = bind(f.value, 'text')
    if (f.op === 'matches')
      return `to_tsvector('english',${column}::text) @@ plainto_tsquery('english',${param})`
    if (f.op === 'starts_with')
      return `left(lower(${column}::text),length(${param}))=lower(${param})`
    if (f.op === 'ends_with')
      return `right(lower(${column}::text),length(${param}))=lower(${param})`
    return f.op === 'contains'
      ? `strpos(lower(${column}::text),lower(${param}))>0`
      : `lower(${column}::text)=lower(${param})`
  }
  const sqlOp = { equals: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[f.op]!
  return `${column}${kind === 'date' ? '::date' : ''} ${sqlOp} ${bind(f.value, kind === 'number' ? 'numeric' : kind === 'date' ? 'date' : 'boolean')}`
}
// EXIF stores these as formatted text. Compare only recognized numeric/rational
// forms; malformed metadata remains unknown instead of throwing or casting to zero.
for (const name of [
  'focal_length',
  'focal_length_35mm',
  'aperture',
  'shutter_speed',
  'exposure_compensation',
  'digital_zoom_ratio',
]) {
  const raw = `trim(p.${name})`
  const cleaned =
    name === 'aperture'
      ? `regexp_replace(${raw}, '^([fF]/?|[fF] )', '')`
      : name.startsWith('focal_length')
        ? `regexp_replace(${raw}, ' *mm$', '', 'i')`
        : name === 'shutter_speed'
          ? `regexp_replace(${raw}, ' *(s|sec|seconds)$', '', 'i')`
          : raw
  metadataFields.set(name, {
    kind: 'number',
    column: `(CASE WHEN ${cleaned} ~ '^[+-]?[0-9]+([.][0-9]+)?$' THEN ${cleaned}::numeric
      WHEN ${cleaned} ~ '^[0-9]+/[0-9]+$'
      THEN split_part(${cleaned},'/',1)::numeric/nullif(split_part(${cleaned},'/',2)::numeric,0) END)`,
  })
}
const metadataWords = new Set(
  [...metadataFields.keys()].map((name) => name.replace(/^album_/, '').replaceAll('_', ' ')),
)
const metadataPattern = new RegExp('\\b(?:' + [...metadataWords].join('|') + ')s?\\b', 'i')
export function asksForMetadata(query: string) {
  const words = query.toLowerCase().replace(/[_-]/g, ' ')
  return (
    metadataPattern.test(words) ||
    /\b(albums?|pictures? without|photos? without|folders?|ocr|transcript|camera|lens|filename|megabytes?|kilobytes?|pixels?|megapixels?|rated|favorites?|favourites?|tagged|uploaded|shutter|exif|iptc|xmp|flash|taken with|shot with|videos?|longer than|shorter than)\b/i.test(
      query,
    )
  )
}

metadataFields.get('album_source_folder')!.description =
  'Original import source path, not the user-visible folder name.'
metadataFields.get('album_event_name')!.description =
  'Album title. Use contains for named/called searches unless the user explicitly requests an exact name.'

// Public field semantics are shared with the interpreter; SQL remains private.
for (const [field, unit, description] of [
  [
    'shutter_speed',
    'seconds',
    'Exposure duration. Faster shutter means a SMALLER duration (lt); slower means gt.',
  ],
  ['aperture', 'f-number', 'Smaller f-number means a wider aperture.'],
  ['focal_length', 'millimeters', 'Recorded focal length.'],
  ['focal_length_35mm', 'millimeters', '35mm-equivalent focal length.'],
  ['duration', 'seconds', 'Video duration.'],
  ['file_size_bytes', 'bytes', 'File size; convert KB/MB/GB to bytes.'],
  ['width', 'pixels', 'Image width.'],
  ['height', 'pixels', 'Image height.'],
  ['latitude', 'degrees', 'Signed geographic latitude.'],
  ['longitude', 'degrees', 'Signed geographic longitude.'],
  ['altitude', 'meters', 'Recorded GPS altitude.'],
  [
    'date_taken',
    'date',
    'Actual capture date; missing explicitly means no photo capture date, without album fallback.',
  ],
  ['location_manually_assigned', '', 'Whether the user assigned the photo location.'],
  [
    'user_tags',
    '',
    'Tags explicitly assigned by the user. Use this for unqualified tagged queries; AI tags require ai_tags.',
  ],
] as const)
  Object.assign(metadataFields.get(field)!, { unit, description })
