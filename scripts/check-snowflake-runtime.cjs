// Validate the deployed standalone tree, not the development node_modules fallback.
const { resolve, join } = require('node:path')
const { existsSync } = require('node:fs')

const sdkRoot = resolve('.next/standalone/node_modules/snowflake-sdk')
const { getMinicoreStatus } = require(join(sdkRoot, 'dist/lib/minicore'))
const status = getMinicoreStatus()
if (
  !status.binaryName ||
  !status.version ||
  status.errorType ||
  status.errorDetails ||
  !existsSync(join(sdkRoot, 'dist/lib/minicore/binaries', status.binaryName))
) {
  throw new Error(
    'Standalone Snowflake SDK native helper failed validation; refusing incomplete build',
  )
}
console.log('Standalone Snowflake SDK native helper verified:', status.binaryName)

const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const patch = require('./snowflake-deadline/patch.json')

if (require(join(sdkRoot, 'package.json')).version !== patch.version)
  throw new Error('Standalone Snowflake SDK deadline version mismatch')
for (const [name, spec] of Object.entries(patch.files)) {
  const hash = createHash('sha256')
    .update(readFileSync(join(sdkRoot, 'dist/lib/http', name)))
    .digest('hex')
  if (hash !== spec.patchedSha256)
    throw new Error('Standalone Snowflake deadline patch missing: ' + name)
}
if (
  !readFileSync(join(sdkRoot, 'dist/lib/http/stillmark_deadline.js')).equals(
    readFileSync(join(__dirname, 'snowflake-deadline/context.cjs')),
  )
)
  throw new Error('Standalone Snowflake deadline context mismatch')
console.log('Standalone Snowflake SDK deadline transport verified')

// Import from the actual standalone tree, with no development fallback. This
// loads the current-platform native library without downloading a model.
const onnxRoot = resolve('.next/standalone/node_modules/onnxruntime-node')
const onnxBinding = join(
  onnxRoot,
  'bin/napi-v6',
  process.platform,
  process.arch,
  'onnxruntime_binding.node',
)
if (!existsSync(onnxBinding)) throw new Error('Standalone ONNX native binding missing')
const { binding } = require(join(onnxRoot, 'dist/binding.js'))
if (!binding) throw new Error('Standalone ONNX native binding failed validation')
console.log('Standalone ONNX runtime verified:', process.platform, process.arch)
