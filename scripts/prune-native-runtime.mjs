import { existsSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { foreignOnnxBinaries } from '../config/native-tracing.mjs'

const root = realpathSync('.next/standalone')
const expected = resolve(root, 'node_modules/onnxruntime-node/bin/napi-v6')
for (const path of foreignOnnxBinaries()) {
  const target = resolve(root, path)
  if (!existsSync(target)) continue
  const actual = realpathSync(target)
  const inside = relative(expected, actual)
  if (isAbsolute(inside) || inside.startsWith('..' + sep) || inside === '..' || actual === expected)
    throw Error('Unexpected native artifact path; refusing to prune')
  rmSync(actual, { recursive: true })
}
console.log('Standalone foreign ONNX binaries removed; build-platform files retained')
