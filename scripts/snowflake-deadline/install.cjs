// Fail closed on SDK upgrades or modified sources. Never fuzzy-patch a dependency.
const { readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createHash } = require('node:crypto')
const patch = require('./patch.json')

const sdkRoot = resolve('node_modules/snowflake-sdk')
const hash = (value) => createHash('sha256').update(value).digest('hex')
if (JSON.parse(readFileSync(join(sdkRoot, 'package.json'))).version !== patch.version)
  throw new Error('Review Snowflake deadline patch before upgrading the SDK')
// Validate every input before writing anything. Repeated installs are idempotent.
const outputs = Object.entries(patch.files).map(([name, spec]) => {
  const file = join(sdkRoot, 'dist/lib/http', name)
  const current = readFileSync(file, 'utf8')
  if (hash(current) === spec.patchedSha256) return [file, current]
  if (hash(current) !== spec.originalSha256)
    throw new Error('Unexpected Snowflake SDK source: ' + name)
  const updated = current.replace(spec.before, spec.after)
  if (hash(updated) !== spec.patchedSha256) throw new Error('Invalid deadline patch: ' + name)
  return [file, updated]
})
for (const [file, text] of outputs) writeFileSync(file, text)
writeFileSync(
  join(sdkRoot, 'dist/lib/http/stillmark_deadline.js'),
  readFileSync(join(__dirname, 'context.cjs')),
)
console.log('Verified Snowflake SDK deadline transport patch:', patch.version)
