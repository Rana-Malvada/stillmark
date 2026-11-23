/** Remove conversational scaffolding, leaving arbitrary scene language for retrieval. */
export function cleanScene(value: string): string {
  return value
    .replace(
      /^(?:(?:i (?:want|would like) to (?:see|find))|(?:(?:please )?(?:show|find|give)(?: me)?))\s*/i,
      '',
    )
    .replace(/^(?:all\s+)?(?:the\s+)?(?:photos?|pictures?|images?)\s*(?:of|with|where)?\s*/i, '')
    .replace(/\bwhere\s+(?:they|he|she)\s+(?:are|is)\b/gi, '')
    .replace(/\b(?:together\s+)?in the same (?:photo|picture|image)\b/gi, '')
    .replace(
      /^(?:\s*(?:and|with|both|together|is|are)\b|[,&])+|(?:\b(?:and|with|both|together)\s*|[,&])+$/gi,
      '',
    )
    .trim()
}

/** Reciprocal-rank fusion does not compare unrelated raw score scales. */
export function fuseRanks(lists: number[][], weights: number[] = []): number[] {
  const scores = new Map<number, number>()
  for (const [channel, list] of lists.entries())
    [...new Set(list)].forEach((id, i) =>
      scores.set(id, (scores.get(id) ?? 0) + (weights[channel] ?? 1) / (60 + i + 1)),
    )
  return [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id)
}

/** Visual similarity corroborates retrieved evidence; it cannot introduce an
 * unsupported subject or widen the permission/person/date candidate set. */
export function fuseSearchRanks(text: number[][], visual: number[]) {
  const supported = new Set(text.flat())
  return fuseRanks(
    [...text, visual.filter((id) => supported.has(id)).slice(0, 100)],
    [...text.map(() => 1), 0.25],
  )
}
