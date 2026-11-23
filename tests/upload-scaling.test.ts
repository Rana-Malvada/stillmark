import { describe, expect, it } from 'vitest'
import { uploadScalingPolicy } from '../workers/upload-cpu/scaling.mjs'

const settings = {
  image: '/worker:v3',
  queuedProcessing: true,
  metricsEnabled: true,
  minInstances: 1,
  maxInstances: 2,
  scaling: {
    enabled: true,
    queueThreshold: 20,
    waitSeconds: 30,
    scaleUpSeconds: 60,
    scaleDownSeconds: 600,
  },
}
const proof = {
  image: '/worker:v3',
  recovery: 'passed',
  scaleOut: 'passed',
  routing: 'passed',
  metrics: 'passed',
  browserRecovery: 'passed',
  automaticScaling: 'passed',
  nodeReclamation: 'passed',
  report: 'report.md',
  testedInstances: 2,
}
describe('upload scaling release gate', () => {
  it('rejects missing, incomplete, stale and insufficient evidence', () => {
    for (const evidence of [
      undefined,
      {},
      { ...proof, recovery: 'pending' },
      { ...proof, browserRecovery: 'pending' },
      { ...proof, automaticScaling: 'pending' },
      { ...proof, nodeReclamation: 'pending' },
      { ...proof, image: '/worker:v2' },
      { ...proof, testedInstances: 1 },
    ])
      expect(() => uploadScalingPolicy(settings, evidence)).toThrow()
  })
  it('disabled means no native CPU autoscaling either', () => {
    expect(() => uploadScalingPolicy({ ...settings, scaling: { enabled: false } }, proof)).toThrow()
    expect(
      uploadScalingPolicy({ ...settings, maxInstances: 1, scaling: { enabled: false } }, proof),
    ).toBeUndefined()
  })
  it('requires queue metrics and safe stabilization', () => {
    expect(() => uploadScalingPolicy({ ...settings, metricsEnabled: false }, proof)).toThrow()
    expect(() =>
      uploadScalingPolicy(
        { ...settings, scaling: { ...settings.scaling, scaleDownSeconds: 30 } },
        proof,
      ),
    ).toThrow()
  })
  it('scales up by queue demand and down only after idle across every replica', () => {
    const p = uploadScalingPolicy(settings, proof)!
    expect(p.scaleUp.anyCondition.map((c) => c.metricCondition.metricName)).toEqual([
      'stillmark.upload.ready',
      'stillmark.upload.oldest_wait_seconds',
    ])
    for (const c of p.scaleUp.anyCondition)
      expect(c.metricCondition.stepScaling.scalingSteps[0].upperBound).toBe(Number.MAX_SAFE_INTEGER)
    expect(p.scaleDown.allConditions.map((c) => c.metricCondition.metricName)).toEqual([
      'stillmark.upload.outstanding',
      'stillmark.upload.local_active',
    ])
    for (const c of p.scaleDown.allConditions) {
      expect(c.metricCondition.aggregationType).toBe('max')
      expect(c.metricCondition.stabilizationPeriodSecs).toBe(600)
      expect(c.metricCondition.stepScaling.scalingSteps[0].upperBound).toBe(0.5)
    }
    expect(p).not.toHaveProperty('suspend')
  })
})
