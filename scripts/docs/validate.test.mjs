import assert from 'node:assert/strict'
import test from 'node:test'
import { validateDocuments } from './validate.mjs'

function check(entries, assets = []) {
  return validateDocuments(new Map(entries), [...entries.map(([name]) => name), ...assets])
}
test('follows nested guides, cycles, encoded asset names and tracked directories', () => {
  assert.deepEqual(
    check(
      [
        ['docs/README.md', '[Guide](guides/one.md#heading)'],
        ['docs/guides/one.md', '[Index](../README.md) ![Image](../a%20b.png) [Source](../../lib)'],
      ],
      ['docs/a b.png', 'lib/source.ts'],
    ),
    [],
  )
})
test('rejects a missing or ignored local artifact and malformed URI', () => {
  const errors = check([['docs/README.md', '[Report](../output/private.pdf) [Bad](%xx.md)']])
  assert.equal(errors.length, 2)
  assert.match(errors[0], /missing link/)
  assert.match(errors[1], /malformed link/)
})
test('rejects an orphan guide even if another orphan links to it', () => {
  const errors = check([
    ['docs/README.md', 'Index'],
    ['docs/one.md', '[Two](two.md)'],
    ['docs/two.md', '[One](one.md)'],
  ])
  assert.equal(errors.length, 2)
  assert.ok(errors.every((error) => error.includes('not reachable')))
})
test('ignores remote URLs, anchors and fenced examples', () => {
  assert.deepEqual(
    check([
      [
        'docs/README.md',
        '[Web](https://example.com) [Top](#top)\n```md\n[X](missing.md)\n```\n~~~md\n[X](other.md)\n~~~',
      ],
    ]),
    [],
  )
})
