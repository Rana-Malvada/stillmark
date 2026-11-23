import { HttpError } from '../http'

const MONTHS =
  'january february march april may june july august september october november december'.split(' ')
const MONTH = MONTHS.join('|')
const YEAR = '(?:19|20)\\d{2}'
const PERIOD = new RegExp(
  `\\b(?:${YEAR}-\\d{2}-\\d{2}|(?:${MONTH})\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+${YEAR}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH})[,]?\\s+${YEAR}|(?:${MONTH})\\s+${YEAR}|${YEAR})\\b`,
  'gi',
)
function bounds(value: string): [string, string] {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const parts = value
    .toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/,/g, '')
    .split(/\s+/)
  const year = iso ? Number(iso[1]) : Number(parts[parts.length - 1])
  const month = iso ? Number(iso[2]) : MONTHS.findIndex((m) => parts.includes(m)) + 1
  const day = iso
    ? Number(iso[3])
    : parts.length === 3
      ? Number(parts.find((v) => /^\d{1,2}$/.test(v)))
      : null
  if (iso && (month < 1 || month > 12)) throw new HttpError(400, 'Invalid search date')
  const last = month ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 31
  if (day !== null && (day < 1 || day > last)) throw new HttpError(400, 'Invalid search date')
  const format = (m: number, d: number) =>
    `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return [format(month || 1, day ?? 1), format(month || 12, day ?? last)]
}
const shift = (value: string, days: number) => {
  const date = new Date(value + 'T00:00:00Z')
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
export function calendarHasDay(query: string) {
  return [...query.matchAll(PERIOD)].some((match) => {
    const [from, through] = bounds(match[0])
    return from === through
  })
}
/** Deterministic calendar filters. Never infer an exact capture day from an album month. */
export function calendarConstraint(
  query: string,
): { scene: string; from: string | null; through: string | null } | null {
  const matches = [...query.matchAll(PERIOD)]
  if (!matches.length) return null
  const first = matches[0]
  const prefix = query.slice(0, first.index)
  const operator =
    /\b(between|from|before|after|since|until|in|during|taken in|taken on|on)\s*$/i.exec(prefix)
  // Bare years may be identifiers; only a named month or ISO date can stand alone.
  if (!operator && /^\d{4}$/.test(first[0])) return null
  let [from, through]: [string | null, string | null] = bounds(first[0])
  let end = first.index + first[0].length
  const op = operator?.[1].toLowerCase()
  if ((op === 'between' || op === 'from') && matches[1]) {
    if (matches.length !== 2) return null
    const second = matches[1]
    const join = query.slice(end, second.index).trim()
    if (!/^(and|to|through|until|-)$/i.test(join)) return null
    through = bounds(second[0])[1]
    end = second.index + second[0].length
    if (from > through) throw new HttpError(400, 'Search start date must be before its end date')
  } else if (op === 'between' || matches.length > 1) return null
  else if (op === 'before') {
    through = shift(from, -1)
    from = null
  } else if (op === 'after') {
    from = shift(through, 1)
    through = null
  } else if (op === 'since') through = null
  else if (op === 'until') from = null
  const start = operator ? operator.index : first.index
  return {
    scene: (query.slice(0, start) + ' ' + query.slice(end)).trim().replace(/\s+/g, ' '),
    from,
    through,
  }
}

export function geoConstraint(query: string) {
  const match =
    /\bwithin\s+(\d+(?:\.\d+)?)\s*(km|kilometers?|miles?)\s+of\s+(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(
      query,
    )
  if (!match) return null
  const latitude = Number(match[3])
  const longitude = Number(match[4])
  const km = Number(match[1]) * (match[2].toLowerCase().startsWith('mile') ? 1.609344 : 1)
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || km <= 0 || km > 20040)
    throw new HttpError(400, 'Invalid GPS search area')
  return { latitude, longitude, km, scene: query.replace(match[0], '').trim() }
}

const seasons: Record<string, number[]> = {
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  autumn: [9, 10, 11],
  fall: [9, 10, 11],
  winter: [12, 1, 2],
}

// A temporal phrase supplies eligibility even when the description never mentions the season.
export function recurringCalendar(query: string) {
  const period = new RegExp(
    `(?:\\b(?:in|during)\\s+(?:the\\s+)?|^)(${MONTH}|spring|summer|autumn|fall|winter)\\b(?:\\s+(?:of\\s+)?(${YEAR}))?(?=\\s|$|[.,?!])`,
    'i',
  ).exec(query)
  if (!period) return null
  const name = period[1].toLowerCase()
  const season = seasons[name]
  const months = season ?? [MONTHS.indexOf(name) + 1]
  return {
    months,
    seasonal: !!season,
    year: period[2] ? Number(period[2]) : null,
    scene: (
      query.slice(0, period.index) +
      ' ' +
      query.slice(period.index + period[0].length)
    ).trim(),
  }
}

// Look up candidate place phrases in caller-visible catalog metadata. This also lets
// lowercase and multiword names work without treating "in a restaurant" as a city.
export function placePhrase(query: string) {
  const m =
    /\b(?:in|at|from)\s+([\p{L}][\p{L}'’.-]*(?:\s+(?!(?:in|at|on|from|during|with|without|before|after|and|or)\b)[\p{L}][\p{L}'’.-]*){0,6})/iu.exec(
      query,
    )
  if (!m || /^(?:a|an|the|this|my|our|front|which)\b/i.test(m[1])) return null
  const words = m[1].trim().split(/\s+/)
  return {
    candidates: words.map((_, i) => words.slice(0, i + 1).join(' ')).reverse(),
    before: query.slice(0, m.index),
    after: query.slice(m.index + m[0].length),
    phrase: m[1],
  }
}
