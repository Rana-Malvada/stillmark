export const COST_TIME_ZONE = 'America/New_York'
/** Calendar date in the report timezone, including daylight-saving transitions. */
export function costDay(timestamp: string, timeZone = COST_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp))
}

/** UTC instant of local midnight, including daylight saving time. */
export function costMidnight(date: string, timeZone = COST_TIME_ZONE) {
  const target = Date.parse(date + 'T00:00:00Z')
  let result = target
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(result))
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]))
    const wall = Date.parse(`${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}Z`)
    result += target - wall
  }
  return result
}
