import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { foreignOnnxBinaries } from '../config/native-tracing.mjs'

it('never excludes the build platform native runtime, including production Linux', () => {
  for (const [platform, arch] of [
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
  ]) {
    const patterns = foreignOnnxBinaries(platform, arch)
    expect(patterns).toHaveLength(5)
    expect(patterns.every((p) => !p.includes(`/${platform}/${arch}/`))).toBe(true)
    expect(
      patterns.every((p) => p.startsWith('./node_modules/onnxruntime-node/bin/napi-v6/')),
    ).toBe(true)
  }
  expect(foreignOnnxBinaries('unknown', 'future')).toEqual([])
})

it('prunes only foreign binaries and refuses an escaping package symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'stillmark-artifact-'))
  const script = resolve('scripts/prune-native-runtime.mjs')
  const standalone = join(root, '.next/standalone')
  const retained = join(
    standalone,
    'node_modules/onnxruntime-node/bin/napi-v6',
    process.platform,
    process.arch,
    'binding.node',
  )
  const foreign = resolve(standalone, foreignOnnxBinaries()[0])
  const outside = join(root, 'outside')
  try {
    mkdirSync(dirname(retained), { recursive: true })
    writeFileSync(retained, 'keep')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'unused.node'), 'foreign')
    execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' })
    expect(existsSync(retained)).toBe(true)
    expect(existsSync(foreign)).toBe(false)
    mkdirSync(outside)
    writeFileSync(join(outside, 'sentinel'), 'keep')
    symlinkSync(outside, foreign, 'dir')
    expect(() => execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' })).toThrow()
    expect(existsSync(join(outside, 'sentinel'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
