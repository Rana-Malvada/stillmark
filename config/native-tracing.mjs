/** A standalone build runs on its build platform (Snowflake rebuilds on Linux).
 * Keep every native file for that platform/architecture, exclude only foreign
 * ONNX runtime binaries. Never exclude model data or JavaScript entry points. */
export function foreignOnnxBinaries(
  platform = String(process.platform),
  arch = String(process.arch),
) {
  const targets = [
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'arm64'],
    ['win32', 'x64'],
  ]
  if (!targets.some(([p, a]) => p === platform && a === arch)) return []
  return targets
    .filter(([p, a]) => p !== platform || a !== arch)
    .map(([p, a]) => `./node_modules/onnxruntime-node/bin/napi-v6/${p}/${a}/`)
}
