const fs = require('node:fs')
const path = require('node:path')

const dir = path.join('.next', 'standalone', 'bin')
fs.mkdirSync(dir, { recursive: true })
for (const [name, source] of [
  ['ffmpeg', require('ffmpeg-static')],
  ['ffprobe', require('ffprobe-static').path],
]) {
  const target = path.join(dir, name)
  fs.copyFileSync(source, target)
  fs.chmodSync(target, 0o755)
}
