'use strict'

module.exports = function verifyBuiltArtifacts(files, manifest, symlinks = []) {
  const builtArtifacts = manifest?.files
  if (!builtArtifacts || !Object.keys(builtArtifacts).length)
    throw new Error('Missing source-built artifact manifest')
  for (const [name, expected] of Object.entries(builtArtifacts)) {
    const file = files.find((entry) => entry.path === name)
    if (!file || file.sha256 !== expected)
      throw new Error(`Source-built artifact does not match compiler output: ${name}`)
  }
  if (!manifest.symlinks || Array.isArray(manifest.symlinks))
    throw new Error('Missing source-built symlink manifest')
  for (const [name, target] of Object.entries(manifest.symlinks)) {
    if (!symlinks.some((entry) => entry.path === name && entry.target === target))
      throw new Error(`Source-built symlink does not match compiler output: ${name}`)
  }
  const replacedFamily = /^(?:ffmpeg|ffprobe|lib\/(?:libav.*|libsw.*|libxml2|libz)\.so(?:\..*)?)$/
  for (const link of symlinks) {
    if (replacedFamily.test(link.path) && !Object.hasOwn(manifest.symlinks, link.path))
      throw new Error(`Unreviewed donor symlink retained: ${link.path}`)
  }
  for (const file of files) {
    if (['ffmpeg', 'libxml2', 'zlib'].includes(file.component) && !builtArtifacts[file.path])
      throw new Error(`Unreviewed donor artifact retained: ${file.path}`)
  }
}
