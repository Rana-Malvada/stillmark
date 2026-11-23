import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deployment } from '../config/deployment.mjs'

const rendered = execFileSync('python3', ['workers/face-cpu/build-control.py'], {
  encoding: 'utf8',
})
const spec = JSON.parse(readFileSync('workers/face-cpu/production-spec.json', 'utf8')).spec
const container = spec.containers[0]

describe('face scan job boundary', () => {
  it('renders both procedures with no unresolved placeholders', () => {
    expect(rendered).not.toMatch(/\{\{|var spec=SPEC/)
    expect(rendered.match(/CREATE OR REPLACE PROCEDURE/g)).toHaveLength(2)
    expect(rendered).toContain(`COMPUTE POOL ${deployment.FACE_POOL} `)
  })
  it('never references or suspends the video GPU pool', () => {
    expect(rendered).not.toContain(deployment.GPU_POOL)
    expect(rendered).not.toContain(deployment.LEGACY_GPU_POOL)
    expect(rendered.match(/ALTER COMPUTE POOL \S+/g)).toEqual([
      `ALTER COMPUTE POOL ${deployment.FACE_POOL}`,
      `ALTER COMPUTE POOL ${deployment.FACE_POOL}`,
    ])
  })
  it('suspends only when no job or service remains on the pool', () => {
    expect(rendered).toMatch(/pool\.jobs===0&&pool\.services===0/)
  })
  it('validates run IDs and actions before building any SQL', () => {
    for (const procedure of rendered.split('CREATE OR REPLACE PROCEDURE').slice(1)) {
      const body = procedure.slice(procedure.indexOf('$$'))
      expect(body.indexOf("throw 'Invalid run ID'")).toBeGreaterThan(0)
      expect(body.indexOf("throw 'Invalid action'")).toBeGreaterThan(0)
      expect(body.indexOf("throw 'Invalid run ID'")).toBeLessThan(body.indexOf('exec('))
    }
  })
  it('bounds runtime and resources and requests no GPU', () => {
    expect(container.command).toEqual(['/usr/bin/timeout'])
    expect(container.args.slice(0, 2)).toEqual(['--kill-after=30s', '7500'])
    expect(Number(container.env.WORKER_MAX_SECONDS)).toBe(120 * 60)
    expect(Number(container.args[1]) - Number(container.env.WORKER_MAX_SECONDS)).toBe(300)
    // Resources come from the validated deployment profile; requests equal limits.
    expect(container.resources.limits).toEqual({
      cpu: Number(deployment.FACE_WORKER_CPU),
      memory: deployment.FACE_WORKER_MEMORY,
    })
    expect(container.resources.requests).toEqual(container.resources.limits)
    expect(Number(container.env.WORKER_PARALLEL)).toBeLessThanOrEqual(
      container.resources.limits.cpu,
    )
    expect(JSON.stringify(container.resources)).not.toContain('gpu')
  })
  it('mounts originals for reading and writes only under faces/', () => {
    const volumes = Object.fromEntries(spec.volumes.map((v: { name: string }) => [v.name, v]))
    expect(volumes.originals.stageConfig.name).toBe(
      `@${deployment.DATABASE}.${deployment.RAW_SCHEMA}.${deployment.PHOTO_STAGE}`,
    )
    expect(volumes.faces.stageConfig.name).toBe(
      `@${deployment.DATABASE}.${deployment.RAW_SCHEMA}.${deployment.DERIVED_STAGE}/faces`,
    )
    expect(container.env.PG_USER).toBe(deployment.FACE_PG_USER)
    expect(container.secrets).toEqual([
      {
        snowflakeSecret: `${deployment.DATABASE}.${deployment.APP_SCHEMA}.${deployment.FACE_SECRET}`,
        directoryPath: '/secrets/PG_SECRET',
      },
    ])
  })
  it('mounts stage volumes for the image’s fixed non-root user', () => {
    // Reads the Dockerfile because the image cannot be built here. Contract pinned: the
    // user the image runs as is the owner the job specification gives its stage volumes;
    // if the two drift apart the worker cannot read or write its files.
    const dockerfile = readFileSync('workers/face-cpu/Dockerfile', 'utf8')
    const uid = Number(/useradd[^\n]*--uid (\d+)/.exec(dockerfile)?.[1])
    const gid = Number(/groupadd[^\n]*--gid (\d+)/.exec(dockerfile)?.[1])
    expect(uid).toBeGreaterThan(0)
    expect(dockerfile).toMatch(/^USER worker$/m)
    for (const volume of spec.volumes) expect([volume.uid, volume.gid]).toEqual([uid, gid])
  })
  it('gives the job role no pool control', () => {
    // Reads the provisioning script because Snowflake grants cannot be applied here.
    // Contract pinned: the statements an operator will run grant pool control to the
    // launcher role only, never to the role the job itself runs as.
    const provision = readFileSync('workers/face-cpu/provision.sql', 'utf8')
    expect(provision).not.toMatch(new RegExp(`OPERATE[^;]*TO ROLE ${deployment.FACE_ROLE};`))
    expect(provision).toMatch(
      new RegExp(
        `OPERATE,MONITOR ON COMPUTE POOL ${deployment.FACE_POOL} TO ROLE ${deployment.FACE_LAUNCHER_ROLE};`,
      ),
    )
    expect(provision).not.toContain(deployment.GPU_POOL)
  })
})
