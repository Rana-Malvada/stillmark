'use strict'
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')

const root = '/usr/lib/jellyfin-ffmpeg'
const libs = fs
  .readdirSync(root + '/lib')
  .filter((n) => /^lib(?:av|sw).*\.so/.test(n))
  .map((n) => root + '/lib/' + n)
const ldd = cp.execFileSync(
  'ldd',
  [root + '/ffmpeg', root + '/ffprobe', '/usr/local/bin/node', ...libs],
  { encoding: 'utf8' },
)
if (/not found/.test(ldd)) throw Error('Existing runtime has unresolved native dependencies')
const required = new Set(
  [...ldd.matchAll(/=>\s+(\/[^\s]+)|^\s+(\/[^\s]+)\s+\(/gm)].map((m) =>
    fs.realpathSync(m[1] || m[2]),
  ),
)
const patterns = [
  /^dri\/(?:i965|iHD|radeonsi)_drv_video\.so$/,
  /^libvulkan_(?:intel|radeon)\.so$/,
  /^lib(?:igdgmm|igfxcmrt|mfxhw64|mfx-gen)\.so(?:\.|$)/,
  /^libmfx-gen\//,
]
const removed = []
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.lstatSync(p)
    if (st.isDirectory()) {
      walk(p)
      continue
    }
    const relative = path.relative(root + '/lib', p)
    if (!patterns.some((r) => r.test(relative))) continue
    const real = fs.realpathSync(p)
    if (required.has(real)) throw Error('Refusing required dynamic dependency: ' + p)
    removed.push({
      path: p,
      realPath: real,
      symlink: st.isSymbolicLink(),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex'),
    })
  }
}
walk(root + '/lib')
const vainfo = root + '/vainfo'
if (fs.existsSync(vainfo)) {
  if (required.has(fs.realpathSync(vainfo))) throw Error('vainfo unexpectedly required')
  removed.push({
    path: vainfo,
    realPath: fs.realpathSync(vainfo),
    symlink: false,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(vainfo)).digest('hex'),
  })
}
for (const f of removed.filter((f) => f.symlink)) fs.unlinkSync(f.path)
for (const f of removed.filter((f) => !f.symlink)) fs.unlinkSync(f.path)
const config = []
const icd = root + '/share/vulkan/icd.d'
if (fs.existsSync(icd)) {
  for (const name of fs.readdirSync(icd)) {
    if (!/^(intel|radeon)/.test(name)) continue
    const p = path.join(icd, name)
    config.push({
      path: p,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
    })
    fs.unlinkSync(p)
  }
}
const after = cp.execFileSync('ldd', [root + '/ffmpeg', root + '/ffprobe', ...libs], {
  encoding: 'utf8',
})
if (/not found/.test(after)) throw Error('Required native dependency removed')
fs.writeFileSync(
  '/worker/runtime-closure.json',
  JSON.stringify(
    {
      policy:
        'Only optional Intel/AMD GPU drivers removed. Core codec/demuxer/filter libraries retained. Production execution is CUDA/NVENC only.',
      requiredFiles: [...required].sort(),
      removedFiles: removed,
      removedConfiguration: config,
    },
    null,
    2,
  ) + '\n',
)
console.log(JSON.stringify({ removedFiles: removed.length, requiredFiles: required.size }))
