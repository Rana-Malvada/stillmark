import { expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : /\.(tsx?|css)$/.test(path) ? [path] : []
  })
}

// A source convention, checked as text on purpose: no component may name a fixed colour.
// There is no behaviour to run instead; rendering every screen in both themes would only
// find the screens a test happened to render. Contract pinned: all colours come from the
// shared theme tokens.
it('keeps application palette choices in the shared theme, including media overlays', () => {
  const fixedColor =
    /(?:bg|text|border|ring|outline|fill|stroke|accent|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:\d+)|(?:bg|text|border|ring|outline|fill|stroke|from|via|to)-(?:white|black)\b|#[\da-fA-F]{3,8}\b|rgba?\(/
  const violations = [
    ...files('app'),
    ...files('components'),
    'public/viewer-menu.css',
    'public/shared-album-info.js',
  ].filter((path) => {
    // Opaque black in an alpha mask defines geometry, not a displayed color.
    const source = readFileSync(path, 'utf8').replace(/mask-image:[^;]+;/g, '')
    return fixedColor.test(source)
  })
  expect(violations).toEqual([])
})
