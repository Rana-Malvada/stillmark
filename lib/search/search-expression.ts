import { metadataClause, type MetadataFilter, validFilter } from './search-metadata'

/** A validated expression describes data, never SQL supplied by an interpreter. */
export type SearchExpression =
  | { all: SearchExpression[] }
  | { any: SearchExpression[] }
  | { not: SearchExpression }
  | { photo: SearchExpression }
  | { person: string }
  | { place: string }
  | { period: string }
  | { terrain: 'mountains' }
  | { near: { latitude: number; longitude: number; km: number } }
  | MetadataFilter

export function validExpression(value: unknown): value is SearchExpression {
  let nodes = 0
  function check(value: unknown, depth: number): boolean {
    if (++nodes > 80 || depth > 8 || !value || typeof value !== 'object' || Array.isArray(value))
      return false
    const node = value as Record<string, unknown>
    const keys = Object.keys(node)
    if ('field' in node)
      return keys.every((k) => ['field', 'op', 'value'].includes(k)) && validFilter(node)
    if (keys.length !== 1) return false
    if ('all' in node || 'any' in node) {
      const children = node.all ?? node.any
      return (
        Array.isArray(children) &&
        children.length > 0 &&
        children.length <= 20 &&
        children.every((child) => check(child, depth + 1))
      )
    }
    if ('not' in node) return check(node.not, depth + 1)
    if ('photo' in node) return check(node.photo, depth + 1)
    if ('terrain' in node) return node.terrain === 'mountains'
    if ('near' in node) {
      const n = node.near as Record<string, unknown> | null
      return (
        !!n &&
        typeof n === 'object' &&
        Object.keys(n).sort().join(',') === 'km,latitude,longitude' &&
        typeof n.latitude === 'number' &&
        Number.isFinite(n.latitude) &&
        Math.abs(n.latitude) <= 90 &&
        typeof n.longitude === 'number' &&
        Number.isFinite(n.longitude) &&
        Math.abs(n.longitude) <= 180 &&
        typeof n.km === 'number' &&
        Number.isFinite(n.km) &&
        n.km > 0 &&
        n.km <= 20040
      )
    }
    return (
      ['person', 'place', 'period'].includes(keys[0]) &&
      typeof node[keys[0]] === 'string' &&
      (node[keys[0]] as string).trim().length > 0 &&
      (node[keys[0]] as string).length <= 150
    )
  }
  return check(value, 0)
}

export function albumDomainExpression(expression: SearchExpression): boolean {
  if ('all' in expression) return expression.all.every(albumDomainExpression)
  if ('any' in expression) return expression.any.every(albumDomainExpression)
  if ('not' in expression) return albumDomainExpression(expression.not)
  if ('photo' in expression) return true
  return 'field' in expression && expression.field.startsWith('album_')
}

export async function compileExpression(
  expression: SearchExpression,
  bind: (value: unknown, type: string) => string,
  resolve: (
    atom: Exclude<
      SearchExpression,
      | MetadataFilter
      | { all: SearchExpression[] }
      | { any: SearchExpression[] }
      | { not: SearchExpression }
    >,
  ) => Promise<string>,
): Promise<string> {
  if ('all' in expression || 'any' in expression) {
    const children = 'all' in expression ? expression.all : expression.any
    const sql: string[] = []
    // Bind numbering must follow compilation order.
    for (const child of children) sql.push(await compileExpression(child, bind, resolve))
    return '(' + sql.join('all' in expression ? ' AND ' : ' OR ') + ')'
  }
  if ('not' in expression)
    return '(NOT (' + (await compileExpression(expression.not, bind, resolve)) + '))'
  if ('field' in expression) return metadataClause(expression, bind)
  return resolve(expression)
}

export function containsPhotoScope(expression: SearchExpression): boolean {
  if ('photo' in expression) return true
  if ('all' in expression) return expression.all.some(containsPhotoScope)
  if ('any' in expression) return expression.any.some(containsPhotoScope)
  if ('not' in expression) return containsPhotoScope(expression.not)
  return false
}
