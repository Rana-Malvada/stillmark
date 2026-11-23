const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
}

const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export function monthName(month: number | null): string {
  if (month == null || month < 1 || month > 12) return ''
  return MONTH_NAMES[month]
}

export interface ParsedFolder {
  sortOrder: number
  eventName: string
  eventMonth: number | null
  eventYear: number | null
  sourceFolder: string
}

export function parseEventFolder(folderName: string): ParsedFolder | null {
  const trimmed = folderName.trim()
  if (!trimmed) return null

  // Try "NNN - rest" first, then "NNN rest" (no dash)
  let match = trimmed.match(/^(\d+)\s*[-–—]\s*(.+)$/)
  if (!match) {
    match = trimmed.match(/^(\d+)\s+(.+)$/)
  }
  if (!match) return null

  const sortOrder = parseInt(match[1], 10)
  const rest = match[2].trim()

  let eventName = rest
  let eventMonth: number | null = null
  let eventYear: number | null = null

  const yearMatch = rest.match(/\b((?:19|20)\d{2})\b/)
  if (yearMatch) {
    eventYear = parseInt(yearMatch[1], 10)
  }

  const words = rest.split(/\s+/)
  for (const word of words) {
    const lower = word.toLowerCase()
    if (MONTHS[lower] !== undefined) {
      eventMonth = MONTHS[lower]
      break
    }
  }

  if (eventMonth !== null || eventYear !== null) {
    const parts = rest.split(/\s+/)
    const nameParts = parts.filter((p) => {
      const lower = p.toLowerCase()
      if (MONTHS[lower] !== undefined) return false
      if (/^(19|20)\d{2}$/.test(p)) return false
      return true
    })
    if (nameParts.length > 0) {
      eventName = nameParts.join(' ')
    }
  }

  return {
    sortOrder,
    eventName,
    eventMonth,
    eventYear,
    sourceFolder: trimmed,
  }
}
