// Attribute every shipped native binary to the pinned source/package inventory.
// Unknown files fail closed; this is provenance, not automatic vulnerability discovery.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const root = '/usr/lib/jellyfin-ffmpeg'
const metadata = '/worker/native-security'
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(metadata, name), 'utf8'))
const bom = readJson('components.cdx.json')
const match = (value, pattern) =>
  new RegExp(
    '^' +
      pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  ).test(value)
const components = bom.components.map((c) => ({
  ...c,
  paths: JSON.parse(c.properties.find((p) => p.name === 'stillmark:runtime-paths').value),
}))
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(name) : entry.isFile() ? [name] : []
  })
}
const files = walk(root)
  .filter((name) => {
    const handle = fs.openSync(name, 'r')
    try {
      const header = Buffer.alloc(4)
      fs.readSync(handle, header, 0, 4, 0)
      return header.equals(Buffer.from([127, 69, 76, 70]))
    } finally {
      fs.closeSync(handle)
    }
  })
  .map((name) => {
    const relative = path.relative(root, name)
    const owners = components.filter((c) => c.paths.some((p) => match(relative, p)))
    if (owners.length !== 1)
      throw new Error(`Expected one provenance owner for ${relative}; found ${owners.length}`)
    return {
      path: relative,
      sha256: digest(fs.readFileSync(name)),
      component: owners[0].name,
      version: owners[0].version,
    }
  })
  .sort((a, b) => a.path.localeCompare(b.path))
for (const component of components) {
  if (!files.some((file) => file.component === component.name))
    throw new Error(`Inventory claims absent component: ${component.name}`)
}
// Source-built libraries must match the compiler output, not a stale donor ELF.
const builtArtifacts = readJson('build-evidence/built-artifacts.json')
const symlinks = []
function links(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name)
    if (entry.isDirectory()) links(name)
    else if (entry.isSymbolicLink()) {
      const resolved = fs.realpathSync(name)
      if (!resolved.startsWith(root + '/'))
        throw new Error(`Native link escapes inventory: ${name}`)
      symlinks.push({ path: path.relative(root, name), target: fs.readlinkSync(name) })
    }
  }
}
links(root)
symlinks.sort((a, b) => a.path.localeCompare(b.path))
require('./artifact-integrity.cjs')(files, builtArtifacts, symlinks)

for (const executable of ['ffmpeg', 'ffprobe']) {
  if (!files.some((file) => file.path === executable))
    throw new Error(`Missing regular executable ${executable}`)
}
const result = {
  architecture: process.arch,
  metadata: Object.fromEntries(
    ['components.cdx.json', 'source-lock.json', 'applicability.json'].map((name) => [
      name,
      digest(fs.readFileSync(path.join(metadata, name))),
    ]),
  ),
  files,
  symlinks,
  ffmpeg: execFileSync(path.join(root, 'ffmpeg'), ['-version'], { encoding: 'utf8' }),
  coverage:
    'ELF inventory and source/package attribution; CPE advisory matching is not exhaustive.',
}
if (process.argv[2] === 'verify') {
  const recorded = readJson('inventory.json')
  if (JSON.stringify(recorded) !== JSON.stringify(result))
    throw new Error('Native files, provenance, or version output changed since build')
  process.stdout.write(JSON.stringify(result) + '\n')
} else
  fs.writeFileSync(path.join(metadata, 'inventory.json'), JSON.stringify(result, null, 2) + '\n')
