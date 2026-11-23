import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'upload-render-'))
  roots.push(root)
  for (const name of ['config', 'workers/upload-cpu/validation'])
    mkdirSync(join(root, name), { recursive: true })
  for (const name of [
    'config/deployment.mjs',
    'config/deployment.json',
    'workers/upload-cpu/render.mjs',
    'workers/upload-cpu/scaling.mjs',
    'workers/upload-cpu/resources.mjs',
    'workers/upload-cpu/validation/render-autoscaling-test.mjs',
    'workers/upload-cpu/validation/autoscaling-probe.cjs',
  ])
    copyFileSync(name, join(root, name))
  const settings = JSON.parse(readFileSync('workers/upload-cpu/settings.json', 'utf8'))
  const save = () =>
    writeFileSync(join(root, 'workers/upload-cpu/settings.json'), JSON.stringify(settings))
  const render = (evidence?: string, isolated = false) => {
    save()
    const env = { ...process.env }
    delete env.UPLOAD_SCALING_EVIDENCE
    if (evidence) env.UPLOAD_SCALING_EVIDENCE = evidence
    return spawnSync(
      process.execPath,
      [
        join(
          root,
          isolated
            ? 'workers/upload-cpu/validation/render-autoscaling-test.mjs'
            : 'workers/upload-cpu/render.mjs',
        ),
      ],
      { env, encoding: 'utf8' },
    )
  }
  const evidence = (changes = {}) => {
    const value = {
      image: settings.image,
      testedInstances: 2,
      report: '.release/review.json',
      ...Object.fromEntries(
        [
          'recovery',
          'scaleOut',
          'routing',
          'metrics',
          'browserRecovery',
          'automaticScaling',
          'nodeReclamation',
        ].map((k) => [k, 'passed']),
      ),
      ...changes,
    }
    const path = join(root, 'private-evidence.json')
    writeFileSync(path, JSON.stringify(value))
    return path
  }
  return { root, settings, render, evidence }
}
describe('offline upload deployment evidence', () => {
  it('disabled scaling renders identically without reading supplied evidence', () => {
    const f = fixture()
    f.settings.scaling.enabled = false
    f.settings.maxInstances = f.settings.minInstances
    expect(f.render().status).toBe(0)
    const path = join(f.root, 'workers/upload-cpu/dist/spec.json')
    const before = readFileSync(path, 'utf8')
    const sql = readFileSync(join(f.root, 'workers/upload-cpu/dist/provision.sql'), 'utf8')
    expect(f.render('/missing/private/report.json').status).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(readFileSync(join(f.root, 'workers/upload-cpu/dist/provision.sql'), 'utf8')).toBe(sql)
  })
  it('enabled scaling fails closed without private evidence and accepts matching reviewed evidence', () => {
    const f = fixture()
    f.settings.scaling.enabled = true
    f.settings.maxInstances = 2
    expect(f.render().status).not.toBe(0)
    expect(f.render('/missing/private/report.json').status).not.toBe(0)
    expect(f.render(f.evidence()).status).toBe(0)
    const spec = JSON.parse(readFileSync(join(f.root, 'workers/upload-cpu/dist/spec.json'), 'utf8'))
    expect(spec.spec.resourceManagement.autoScalingPolicies).toBeTruthy()
  })
  it.each([
    { image: '/other/image:old' },
    { recovery: 'failed' },
    { testedInstances: 1 },
    { report: '' },
  ])('rejects stale or incomplete private evidence %j', (changes) => {
    const f = fixture()
    f.settings.scaling.enabled = true
    f.settings.maxInstances = 2
    expect(f.render(f.evidence(changes)).status).not.toBe(0)
  })
  it('both renderers accept and preserve an immutable image digest', () => {
    const f = fixture()
    f.settings.image = '/db/schema/repository/upload@sha256:' + 'a'.repeat(64)
    expect(f.render().status).toBe(0)
    expect(f.render(undefined, true).status).toBe(0)
    for (const name of ['spec.json', 'autoscaling-test/spec.json'])
      expect(
        JSON.parse(readFileSync(join(f.root, 'workers/upload-cpu/dist', name), 'utf8')).spec
          .containers[0].image,
      ).toBe(f.settings.image)
  })
  it.each([
    '/db/schema/repo/upload@sha256:bad',
    '/db/schema/repo/upload@sha256:' + 'a'.repeat(63),
    '/db/schema/repo/upload@sha256:' + 'g'.repeat(64),
    '/db/schema/repo/upload@sha256:' + 'a'.repeat(64) + ';drop',
  ])('both renderers reject malformed digests %s', (image) => {
    const f = fixture()
    f.settings.image = image
    expect(f.render().status).not.toBe(0)
    expect(f.render(undefined, true).status).not.toBe(0)
  })
})
