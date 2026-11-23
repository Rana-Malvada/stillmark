// Generates an isolated, disposable controller test. Does not execute SQL, alter
// production settings, or mark production evidence as passed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { uploadScalingPolicy } from '../scaling.mjs'

const root = new URL('../', import.meta.url)
const settings = JSON.parse(readFileSync(new URL('settings.json', root)))
if (!/^\/[a-z0-9_/.:-]+(?:@sha256:[a-f0-9]{64})?$/.test(settings.image))
  throw Error('Invalid image')
const testSettings = {
  ...settings,
  minInstances: 1,
  maxInstances: 2,
  scaling: { ...settings.scaling, enabled: true },
}
// Test-only fixture authorizes rendering this isolated specification. It is NOT
// written into a production evidence report and must never be used for the live upload service.
const testEvidence = Object.fromEntries(
  [
    'recovery',
    'scaleOut',
    'routing',
    'metrics',
    'browserRecovery',
    'automaticScaling',
    'nodeReclamation',
  ].map((k) => [k, 'passed']),
)
const policy = uploadScalingPolicy(testSettings, {
  ...testEvidence,
  image: settings.image,
  testedInstances: 2,
  report: 'isolated-controller-test',
})
const loadEnd = Date.now() + 300000
const spec = {
  spec: {
    containers: [
      {
        name: 'probe',
        image: settings.image,
        command: [
          'node',
          '-e',
          readFileSync(new URL('autoscaling-probe.cjs', import.meta.url), 'utf8'),
        ],
        env: { VALIDATE_LOAD_END_MS: String(loadEnd) },
        resources: { requests: { cpu: 1, memory: '256Mi' }, limits: { cpu: 1, memory: '512Mi' } },
      },
    ],
    platformMonitor: { metricConfig: { groups: ['system', 'status'] } },
    resourceManagement: { autoScalingPolicies: policy },
  },
}
const directory = new URL('dist/autoscaling-test/', root)
mkdirSync(directory, { recursive: true })
writeFileSync(new URL('spec.json', directory), JSON.stringify(spec, null, 2) + '\n')
writeFileSync(
  new URL('create.sql', directory),
  `USE ROLE ACCOUNTADMIN;
CREATE COMPUTE POOL STILLMARK_UPLOAD_SCALE_TEST MIN_NODES=1 MAX_NODES=2 INSTANCE_FAMILY=CPU_X64_XS AUTO_RESUME=FALSE AUTO_SUSPEND_SECS=60;
GRANT USAGE ON COMPUTE POOL STILLMARK_UPLOAD_SCALE_TEST TO ROLE PERSONAL_PHOTOS_UPLOAD_WORKER;
USE ROLE PERSONAL_PHOTOS_UPLOAD_WORKER;
CREATE SERVICE PERSONAL_MEDIA.APP.STILLMARK_UPLOAD_SCALE_TEST IN COMPUTE POOL STILLMARK_UPLOAD_SCALE_TEST MIN_INSTANCES=1 MAX_INSTANCES=2 AUTO_RESUME=FALSE FROM SPECIFICATION $$${JSON.stringify(spec)}$$;
`,
)
console.log(
  `Generated isolated test, backlog ends ${new Date(loadEnd).toISOString()}; execute promptly. No infrastructure changed.`,
)
