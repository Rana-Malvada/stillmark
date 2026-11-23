import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { deployment } from '../config/deployment.mjs'
import { renderDeployment } from '../config/render.mjs'

type WorkerSpec = {
  spec: { volumes: { name: string; source: string; uid?: number; gid?: number }[] }
}

function controlSpec(sql: string): WorkerSpec {
  const match = sql.match(/ var spec=(.*);\n spec\.spec\.containers/)
  if (!match) throw new Error('Expected one embedded video job specification')
  return JSON.parse(match[1])
}

function assertStageIdentity(spec: WorkerSpec) {
  const stages = spec.spec.volumes.filter((volume) => volume.source === 'stage')
  expect(stages.map((volume) => volume.name).sort()).toEqual(['originals', 'playback'])
  for (const stage of stages) {
    expect(stage.uid, `${stage.name} must be readable/writable by the non-root worker`).toBe(65532)
    expect(stage.gid, `${stage.name} must match the non-root worker group`).toBe(65532)
  }
}

describe('non-root video stage mount ownership', () => {
  it('keeps the final image identity explicit', () => {
    // Reads the Dockerfile because the image cannot be built here. Contract pinned: the
    // image's final user is 65532:65532, the owner every specification below gives the
    // stage volumes.
    const dockerfile = readFileSync('workers/video-gpu/Dockerfile', 'utf8')
    expect(dockerfile.match(/^USER .+$/gm)?.at(-1)).toBe('USER 65532:65532')
  })
  it('sets ownership in both source and generated production specifications', () => {
    assertStageIdentity(
      JSON.parse(
        renderDeployment(
          readFileSync('config/templates/workers/video-gpu/production-spec.json', 'utf8'),
          deployment,
        ),
      ),
    )
    assertStageIdentity(JSON.parse(readFileSync('workers/video-gpu/production-spec.json', 'utf8')))
  })
  it('sets ownership in the setup control procedure template', () => {
    assertStageIdentity(
      controlSpec(
        renderDeployment(readFileSync('config/templates/video-control.sql', 'utf8'), deployment),
      ),
    )
  })
  it('preserves ownership in the production control procedure renderer', () => {
    assertStageIdentity(
      controlSpec(
        execFileSync('python3', ['workers/video-gpu/build-control.py'], {
          encoding: 'utf8',
        }),
      ),
    )
  })
})
