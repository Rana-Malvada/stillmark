/** Full names and complete first names; prefixes stay suggestions, never identity filters. */
export function personNames(name: string): string[] {
  const full = name.trim().replace(/\s+/g, ' ').toLowerCase()
  return [...new Set([full, full.split(' ')[0]])]
}

export function replacePersonName(query: string, name: string, replacement: string): string {
  let text = ` ${query.trim().replace(/\s+/g, ' ')} `
  for (const alias of personNames(name)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'),
      replacement,
    )
  }
  return text.trim().replace(/\s+/g, ' ')
}
