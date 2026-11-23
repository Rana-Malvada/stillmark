import { metadataFields } from './search-metadata'
import { type SearchExpression, validExpression } from './search-expression'

const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})
/** A flat node list keeps the provider grammar small. The internal representation
 * remains a bounded tree; references are validated before SQL compilation. */
export function searchPlanSchema(kind: 'photo' | 'event') {
  const index = { type: 'integer' }
  const indices = { type: 'array', items: index, minItems: 1 }
  return object({
    nodes: {
      type: 'array',
      items: {
        anyOf: [
          object({ all: indices }),
          object({ any: indices }),
          object({ not: index }),
          ...(kind === 'event' ? [object({ photo: index })] : []),
          object({ person: { type: 'string' } }),
          object({ place: { type: 'string' } }),
          object({ period: { type: 'string' } }),
          object({ terrain: { type: 'string', enum: ['mountains'] } }),
          object({
            near: object({
              latitude: { type: 'number' },
              longitude: { type: 'number' },
              km: { type: 'number' },
            }),
          }),
          object({
            field: { type: 'string', enum: [...metadataFields.keys()] },
            op: {
              type: 'string',
              enum: [
                'equals',
                'contains',
                'matches',
                'starts_with',
                'ends_with',
                'lt',
                'lte',
                'gt',
                'gte',
                'missing',
                'exists',
              ],
            },
            value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          }),
        ],
      },
    },
    root: { anyOf: [index, { type: 'null' }] },
    keywords: { type: 'string' },
    clarification: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  })
}
export function expressionFromNodes(nodes: unknown, root: unknown): SearchExpression | null {
  const fail = () => {
    throw Error('Invalid search expression references')
  }
  if (!Array.isArray(nodes) || nodes.length > 80) return fail()
  if (root === null) {
    if (nodes.length) return fail()
    return null
  }
  const items = nodes
  const used = new Set<number>()
  let expanded = 0
  function read(index: unknown, path: Set<number>): unknown {
    if (
      !Number.isInteger(index) ||
      Number(index) < 0 ||
      Number(index) >= items.length ||
      path.has(Number(index)) ||
      path.size > 8 ||
      ++expanded > 80
    )
      return fail()
    const i = Number(index)
    const node = items[i]
    if (!node || typeof node !== 'object' || Array.isArray(node)) return fail()
    used.add(i)
    const children = new Set(path).add(i)
    if ('all' in node || 'any' in node) {
      if (Object.keys(node).length !== 1) return fail()
      const key = 'all' in node ? 'all' : 'any'
      if (!Array.isArray(node[key]) || !node[key].length || node[key].length > 20) return fail()
      return { [key]: node[key].map((child: unknown) => read(child, children)) }
    }
    if ('not' in node || 'photo' in node) {
      if (Object.keys(node).length !== 1) return fail()
      const key = 'not' in node ? 'not' : 'photo'
      return { [key]: read(node[key], children) }
    }
    return node
  }
  const expression = read(root, new Set())
  if (used.size !== nodes.length || !validExpression(expression)) return fail()
  return expression
}
