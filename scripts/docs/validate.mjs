import path from 'node:path'

// Deliberately checks local inline Markdown links, not remote URLs or heading anchors.
export function validateDocuments(documents, files, entry = 'docs/README.md') {
  const tracked = new Set(files)
  const edges = new Map()
  const errors = []
  for (const [file, source] of documents) {
    const links = []
    edges.set(file, links)
    const text = source.replace(/```[^]*?```/g, '').replace(/~~~[^]*?~~~/g, '')
    for (const match of text.matchAll(/\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1].replace(/^<|>$/g, '')
      if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) continue
      let relative
      try {
        relative = decodeURIComponent(href.split('#')[0])
      } catch {
        errors.push(`${file}: malformed link ${href}`)
        continue
      }
      if (!relative) continue
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), relative))
      if (tracked.has(target)) links.push(target)
      else if (![...tracked].some((name) => name.startsWith(target + '/')))
        errors.push(`${file}: untracked or missing link ${href}`)
    }
  }
  const reached = new Set()
  const visit = (file) => {
    if (reached.has(file)) return
    reached.add(file)
    for (const target of edges.get(file) ?? []) visit(target)
  }
  visit(entry)
  for (const file of documents.keys()) {
    if (file.startsWith('docs/') && !reached.has(file))
      errors.push(`${file}: not reachable from ${entry}`)
  }
  return errors
}
