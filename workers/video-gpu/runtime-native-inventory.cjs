// Preserve package provenance for native libraries copied from the FFmpeg image.
// The final stage retains only byte-identical donor files after OS patching.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const output = process.argv[3]
if (process.argv[2] === 'retain') {
  const inventory = JSON.parse(fs.readFileSync(output, 'utf8'))
  inventory.replacedByFinalStage = []
  inventory.files = inventory.files.filter((file) => {
    if (fs.existsSync(file.path) && digest(file.path) === file.sha256) return true
    inventory.replacedByFinalStage.push(file.path)
    return false
  })
  fs.writeFileSync(output, JSON.stringify(inventory, null, 2) + '\n')
} else {
  const files = []
  function visit(root, prefix = '') {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const source = path.join(root, entry.name)
      if (entry.isDirectory()) visit(source, prefix)
      else if (fs.statSync(source).isFile()) {
        const target = prefix ? source.slice(prefix.length) : source
        let pkg = null
        // Merged-/usr images may record either spelling in dpkg's file lists.
        for (const candidate of [
          fs.realpathSync(target),
          target,
          target.replace(/^\/usr\/(lib|bin|sbin)\//, '/$1/'),
        ]) {
          try {
            const owner = execFileSync('dpkg-query', ['-S', candidate], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            })
              .trim()
              .split('\n')[0]
              .split(': ')[0]
            const [name, version, architecture] = execFileSync(
              'dpkg-query',
              ['-W', '-f', '${binary:Package}\t${Version}\t${Architecture}', owner],
              { encoding: 'utf8' },
            ).split('\t')
            pkg = { name: name.replace(/:[^:]+$/, ''), version, architecture }
            break
          } catch {}
        }
        files.push({ path: target, sha256: digest(source), package: pkg })
      }
    }
  }
  visit('/runtime', '/runtime')
  visit('/usr/lib/jellyfin-ffmpeg')
  const inventory = {
    donorImage: process.argv[4],
    osRelease: fs.readFileSync('/etc/os-release', 'utf8'),
    files,
  }
  fs.writeFileSync(output, JSON.stringify(inventory, null, 2) + '\n')
}
