/** Ranking evidence is not an authorization or identity decision. Missing OCR is
 * unknown, never proof that the requested subject is absent. */
export type IdentifierRequirement = { kind: 'plate' | 'race' | 'plate-region'; value: string }
const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '')
const plateTokens = (value: string) =>
  (value.match(/\b[A-Z0-9]{2,8}(?:-[A-Z0-9]{1,6})?\b/gi) ?? [])
    .map(normalize)
    .filter((v) => v.length >= 4 && v.length <= 12 && /[A-Z]/.test(v) && /\d/.test(v))
const racing = /\b(?:motocross|racers?|racing|riders?|race|jersey|bikes?)\b/i
const numbered = /(?:\b(?:number(?:ed)?|nubmer|no\.|wearing|displaying)\s*|#\s*)["']?(\d{1,4})\b/gi

// Only explicit plate jurisdictions are parsed; a photo/album location does not
// establish where its license plate was issued.
const plateRegions =
  'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia'.split(
    '|',
  )
const plateRegionMatchers = plateRegions.map((region) => ({
  region,
  pattern: new RegExp(
    `\\b${region}\\s+(?:state\\s+)?(?:licen[cs]e\\s+|registration\\s+)?plates?\\b|\\b(?:licen[cs]e\\s+|registration\\s+)?plates?\\s+(?:from|of)\\s+${region}\\b`,
    'gi',
  ),
}))
function plateRegion(value: string): string[] {
  const matches = plateRegionMatchers.flatMap(({ region, pattern }) =>
    [...value.matchAll(pattern)].map((match) => ({ region, match })),
  )
  return matches
    .filter(
      (entry) =>
        !matches.some(
          (other) =>
            other !== entry &&
            other.region.length > entry.region.length &&
            other.match!.index <= entry.match!.index &&
            other.match!.index + other.match![0].length >=
              entry.match!.index + entry.match![0].length,
        ),
    )
    .map(({ region }) => region)
}

export function identifierRequirements(query: string): IdentifierRequirement[] {
  // Exclusions/alternatives must be resolved by the intent layer, not guessed here.
  if (/\b(?:not|without|except|excluding|or|neither)\b/i.test(query)) return []
  const requirements: IdentifierRequirement[] = plateRegion(query).map((value) => ({
    kind: 'plate-region',
    value,
  }))
  if (
    /\b(?:licen[cs]e|registration|number)\s+plates?\b|\bplate\s+(?:number|reading)\b/i.test(query)
  )
    for (const value of plateTokens(query)) requirements.push({ kind: 'plate', value })
  if (racing.test(query))
    for (const match of query.matchAll(numbered))
      requirements.push({ kind: 'race', value: match[1] })
  return requirements.filter(
    (r, i) => requirements.findIndex((x) => x.kind === r.kind && x.value === r.value) === i,
  )
}

/** Add subject context so a bare race number cannot retrieve dates or addresses.
 * Every OR arm includes the literal; the value is still a bound SQL parameter. */
export function literalSearchQuery(query: string): string {
  return identifierRequirements(query)
    .flatMap(({ kind, value }) => {
      const literal = `"${value}"`
      const context =
        kind === 'race'
          ? ['motocross', 'racer', 'racing', 'rider', 'bike', 'jersey']
          : kind === 'plate-region'
            ? ['license', 'registration', 'plate']
            : []
      return context.length ? context.map((word) => `${literal} ${word}`) : [literal]
    })
    .join(' OR ')
}

function photoEvidence(row: Record<string, unknown>) {
  return [
    row.caption,
    row.aiDescription,
    ...(Array.isArray(row.aiTags) ? row.aiTags : []),
    ...(Array.isArray(row.userTags) ? row.userTags : []),
    ...(Array.isArray(row.iptcKeywords) ? row.iptcKeywords : []),
  ]
    .filter(Boolean)
    .join(' ')
}

/** 2 = supported in photo evidence, 1 = unknown, 0 = conflicting identifiers.
 * Album names, dates and filenames cannot establish a number visible in a photo. */
export function evidenceTier(
  requirements: IdentifierRequirement[],
  row: Record<string, unknown>,
): number {
  if (!requirements.length) return 1
  const evidence = photoEvidence(row)
  const ocr = String(row.ocrText ?? '')
  return Math.min(
    ...requirements.map((requirement) => {
      if (requirement.kind === 'plate-region') {
        const regions = plateRegion(evidence)
        // OCR must contain the full jurisdiction name, not an ambiguous abbreviation.
        const ocrSupport =
          /\bplate\b/i.test(evidence) && new RegExp(`\\b${requirement.value}\\b`, 'i').test(ocr)
        return regions.includes(requirement.value) || ocrSupport ? 2 : regions.length ? 0 : 1
      }
      if (requirement.kind === 'plate') {
        const contextual = [...evidence.matchAll(/\bplate\b[^.!?]{0,100}/gi)].flatMap((m) =>
          plateTokens(m[0]),
        )
        const supported =
          contextual.includes(requirement.value) || plateTokens(ocr).includes(requirement.value)
        return supported ? 2 : contextual.length ? 0 : 1
      }
      if (!racing.test(evidence)) return 1
      const numbers = [...evidence.matchAll(numbered)].map((m) => m[1])
      // Descriptions of a starting grid often enumerate several visible plates.
      // Restrict extraction to the number list, not arbitrary digits in the scene.
      for (const list of evidence.matchAll(
        /\b(?:numbers|numbered plates)\s+(?:(?:visible|include|including|are|shown)\s+)*((?:\d{1,4}\s*(?:,\s*(?:and\s+)?|and\s+)?)+)/gi,
      ))
        numbers.push(...(list[1].match(/\d{1,4}/g) ?? []))
      const ocrNumbers: string[] = ocr.match(/\b\d{1,4}\b/g) ?? []
      return numbers.includes(requirement.value) || ocrNumbers.includes(requirement.value)
        ? 2
        : numbers.length
          ? 0
          : 1
    }),
  )
}

export function protectEvidence<T extends Record<string, unknown>>(query: string, rows: T[]): T[] {
  const requirements = identifierRequirements(query)
  return rows
    .map((row, index) => ({
      row,
      index,
      tier: evidenceTier(requirements, row),
    }))
    .sort((a, b) => b.tier - a.tier || a.index - b.index)
    .map(({ row }) => row)
}

/** Exact identifiers require supporting evidence; unknown candidates are not claimed as matches. */
export function supportedEvidence<T extends Record<string, unknown>>(
  query: string,
  rows: T[],
): T[] {
  const requirements = identifierRequirements(query)
  return requirements.length ? rows.filter((row) => evidenceTier(requirements, row) === 2) : rows
}
export function prioritizePhotoEvidence<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        Number(Boolean(b.row.subjectMatch)) - Number(Boolean(a.row.subjectMatch)) ||
        a.index - b.index,
    )
    .map(({ row }) => row)
}

/** Visual resemblance cannot adjudicate literal identifiers, quantities or quotes. */
export function allowsVisualSearch(query: string): boolean {
  return !/\d|["“”]|\b(?:number|nubmer|plate|plates|menus?|receipts?|documents?|written|without|except|excluding|not)\b/i.test(
    query,
  )
}

export function rankingDocument(row: Record<string, unknown>, query: string, id: number) {
  const field = (label: string, value: unknown, limit: number) => {
    const text = (Array.isArray(value) ? value.join(', ') : String(value ?? '')).trim()
    return text ? `${label}: ${text.slice(0, limit)}` : ''
  }
  // Put photo evidence first, reserving room for every field before model truncation.
  const text = [
    field('Photo description', row.aiDescription, 900),
    field('Caption', row.caption, 250),
    field(
      'Photo tags',
      [
        ...(Array.isArray(row.aiTags) ? row.aiTags : []),
        ...(Array.isArray(row.userTags) ? row.userTags : []),
      ],
      250,
    ),
    field('Text visible in photo (OCR)', row.ocrText, 450),
    field('Album context (not necessarily visible)', row.eventName, 120),
    field('Location metadata', [row.locationName, row.city, row.country].filter(Boolean), 150),
  ]
    .filter(Boolean)
    .join('\n')
  return {
    id,
    text,
    formatVersion: 2,
    evidenceTier: evidenceTier(identifierRequirements(query), row),
  }
}

/** A model may reorder candidates but cannot invent/drop IDs or override evidence.
 * Blend ranks conservatively: the established retrieval order has three times the
 * weight of the optional model. The same deterministic order is used on all pages. */
export function guardedBatchOrder(
  baseline: number[],
  proposed: number[],
  documents: { id: number; evidenceTier?: number; retrievalTier?: number }[],
): number[] {
  const allowed = new Set(baseline)
  const model = [...new Set(proposed)].filter((id) => allowed.has(id))
  const ranks = new Map(model.map((id, index) => [id, index]))
  const tiers = new Map(documents.map((d) => [d.id, d.evidenceTier ?? 1]))
  const retrieval = new Map(documents.map((d) => [d.id, d.retrievalTier ?? 0]))
  return [...new Set(baseline)]
    .map((id, index) => ({
      id,
      index,
      tier: tiers.get(id) ?? 1,
      retrieval: retrieval.get(id) ?? 0,
      score: 3 / (61 + index) + (ranks.has(id) ? 1 / (61 + ranks.get(id)!) : 0),
    }))
    .sort(
      (a, b) =>
        b.tier - a.tier || b.retrieval - a.retrieval || b.score - a.score || a.index - b.index,
    )
    .map((r) => r.id)
}

/** Preserve a clearly separated leading relevance group during optional replay.
 * Compare scores only within this query and this scorer, never across models.
 * Unknown/missing scores are not evidence of irrelevance and are never removed. */
export function rankingDocuments(
  rows: Record<string, unknown>[],
  query: string,
  idKey = 'photoId',
) {
  const score = (r: Record<string, unknown>) =>
    (r.scores as Record<string, number> | undefined)?.reranker_score
  const scored = rows
    .map(score)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s))
    .sort((a, b) => b - a)
  let cutoff: number | undefined
  for (let i = 1; i < Math.min(scored.length - 1, 9); i++) {
    if (scored[0] - scored[i] <= 1.5 && scored[i] - scored[i + 1] >= 1) {
      cutoff = scored[i]
      break
    }
  }
  return rows.map((row) => ({
    ...rankingDocument(row, query, Number(row[idKey])),
    retrievalTier:
      cutoff !== undefined && score(row) !== undefined && score(row)! >= cutoff ? 1 : 0,
  }))
}
