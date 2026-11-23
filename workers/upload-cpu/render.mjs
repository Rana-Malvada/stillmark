// Offline deployment artifact generation; never executes SQL or enables routing.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deployment as d } from '../../config/deployment.mjs'
import { uploadScalingPolicy } from './scaling.mjs'
import { uploadWorkerResources } from './resources.mjs'

const settings = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url)))
const evidencePath = process.env.UPLOAD_SCALING_EVIDENCE
const evidence =
  settings.scaling?.enabled && evidencePath
    ? JSON.parse(readFileSync(evidencePath, 'utf8'))
    : undefined
const scalingPolicy = uploadScalingPolicy(settings, evidence)
for (const key of ['minNodes', 'maxNodes', 'minInstances', 'maxInstances']) {
  if (!Number.isSafeInteger(settings[key]) || settings[key] < 1 || settings[key] > 10000)
    throw Error(`Invalid ${key}`)
}
if (
  settings.completionsPerInstance !== 'auto' &&
  (!Number.isSafeInteger(settings.completionsPerInstance) ||
    settings.completionsPerInstance < 1 ||
    settings.completionsPerInstance > 10000)
)
  throw Error('Invalid completionsPerInstance')
const permissionAuthority = settings.permissionAuthority ?? 'snowflake'
if (!['snowflake', 'postgres'].includes(permissionAuthority))
  throw Error('Invalid permission authority')
const family = settings.instanceFamily ?? 'CPU_X64_XS'
const resources = uploadWorkerResources(family)
if (settings.maxNodes < settings.minNodes || settings.maxInstances < settings.minInstances)
  throw Error('Invalid scaling bounds')
if (!/^\/[a-z0-9_/.:-]+(?:@sha256:[a-f0-9]{64})?$/.test(settings.image))
  throw Error('Invalid image')
const schema = `${d.DATABASE}.${d.APP_SCHEMA}`
const spec = {
  spec: {
    containers: [
      {
        name: 'upload',
        image: settings.image,
        env: {
          UPLOAD_SERVICE_ONLY: 'true',
          UPLOAD_PROCESSING_QUEUE_ENABLED: String(settings.queuedProcessing === true),
          UPLOAD_ROUTING_MANAGED: String(settings.managedRouting === true),
          UPLOAD_QUEUE_METRICS_ENABLED: String(settings.metricsEnabled === true),
          BACKGROUND_JOBS_ENABLED: 'false',
          UV_THREADPOOL_SIZE: String(Math.max(4, resources.limits.cpu * 2)),
          UPLOAD_COMPLETIONS_PER_INSTANCE: String(settings.completionsPerInstance),
          UPLOAD_CHUNKS_PER_INSTANCE: settings.completionsPerInstance === 'auto' ? 'auto' : '8',
          UPLOAD_RESOURCE_CPU: String(resources.limits.cpu),
          UPLOAD_RESOURCE_MEMORY_MIB: String(
            Number(resources.limits.memory.replace('Gi', '')) * 1024,
          ),
          UPLOAD_SESSIONS_GLOBAL: '0',
          GATEWAY_AUTH_ENABLED: 'true',
          APP_PERMISSION_AUTHORITY: permissionAuthority,
          CUSTOMER_ACCOUNTS_ENABLED: String(settings.customerAccountsEnabled === true),
          GATEWAY_ORIGIN: d.GATEWAY_ORIGIN,
          SNOWFLAKE_ACCOUNT: d.SNOWFLAKE_ACCOUNT,
          SNOWFLAKE_DATABASE: d.DATABASE,
          SNOWFLAKE_SCHEMA: d.APP_SCHEMA,
          PG_HOST: d.PG_HOST,
          PG_DATABASE: d.PG_DATABASE,
          PG_USER: d.PG_USER,
          PG_SSL: 'true',
          PG_SSL_ROOT_CERT: '/app/certs/postgres-root.crt',
        },
        secrets: [
          ...(settings.queuedProcessing === true
            ? [
                {
                  snowflakeSecret: `${schema}.PG_UPLOAD_QUEUE_SECRET`,
                  directoryPath: '/secrets/PG_UPLOAD_QUEUE',
                },
              ]
            : []),
          { snowflakeSecret: `${schema}.PG_APP_SECRET`, directoryPath: '/secrets/PG_SECRET' },
          {
            snowflakeSecret: `${schema}.GATEWAY_SIGNING`,
            directoryPath: '/secrets/GATEWAY_SIGNING',
          },
        ],
        resources,
        readinessProbe: {
          port: 3000,
          path:
            settings.queuedProcessing === true ? '/api/health/upload-ready' : '/api/health/live',
        },
      },
    ],
    endpoints: [{ name: 'upload', port: 3000, public: true }],
    platformMonitor: { metricConfig: { groups: ['system', 'system_limits', 'status'] } },
    ...(scalingPolicy ? { resourceManagement: { autoScalingPolicies: scalingPolicy } } : {}),
  },
  capabilities: { securityContext: { executeAsCaller: true } },
}
const role = 'PERSONAL_PHOTOS_UPLOAD_WORKER'
const pool = 'PERSONAL_PHOTOS_UPLOAD_CPU'
const service = `${schema}.PERSONAL_PHOTOS_UPLOAD`
const queueSecretGrant =
  settings.queuedProcessing === true
    ? `GRANT READ ON SECRET ${schema}.PG_UPLOAD_QUEUE_SECRET TO ROLE ${role};\n`
    : ''
const queueSecretAllowed =
  settings.queuedProcessing === true ? `,${schema}.PG_UPLOAD_QUEUE_SECRET` : ''
const sql = `-- Review and execute with administrative provisioning rights. No warehouse is selected.
CREATE ROLE IF NOT EXISTS ${role};
CREATE COMPUTE POOL IF NOT EXISTS ${pool} MIN_NODES=${settings.minNodes} MAX_NODES=${settings.maxNodes} INSTANCE_FAMILY=${family} AUTO_RESUME=FALSE AUTO_SUSPEND_SECS=900;
GRANT USAGE ON DATABASE ${d.DATABASE} TO ROLE ${role};
GRANT USAGE ON SCHEMA ${schema} TO ROLE ${role};
GRANT USAGE ON SCHEMA ${d.DATABASE}.${d.RAW_SCHEMA} TO ROLE ${role};
GRANT CREATE SERVICE ON SCHEMA ${schema} TO ROLE ${role};
GRANT USAGE ON COMPUTE POOL ${pool} TO ROLE ${role};
GRANT READ ON IMAGE REPOSITORY ${schema}.${d.IMAGE_REPOSITORY} TO ROLE ${role};
GRANT READ, WRITE ON STAGE ${d.DATABASE}.${d.RAW_SCHEMA}.${d.PHOTO_STAGE} TO ROLE ${role};
GRANT READ ON SECRET ${schema}.PG_APP_SECRET TO ROLE ${role};
GRANT READ ON SECRET ${schema}.GATEWAY_SIGNING TO ROLE ${role};
${queueSecretGrant}CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS PERSONAL_PHOTOS_UPLOAD_EAI
 ALLOWED_NETWORK_RULES=(${schema}.${d.PG_NETWORK_RULE},${schema}.S3_STAGE_EGRESS_RULE)
 ALLOWED_AUTHENTICATION_SECRETS=(${schema}.PG_APP_SECRET,${schema}.GATEWAY_SIGNING${queueSecretAllowed}) ENABLED=TRUE;
ALTER EXTERNAL ACCESS INTEGRATION PERSONAL_PHOTOS_UPLOAD_EAI SET ALLOWED_AUTHENTICATION_SECRETS=(${schema}.PG_APP_SECRET,${schema}.GATEWAY_SIGNING${queueSecretAllowed});
GRANT USAGE ON INTEGRATION PERSONAL_PHOTOS_UPLOAD_EAI TO ROLE ${role};
GRANT MONITOR USER ON ACCOUNT TO ROLE ${role};
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO ROLE ${role};
GRANT ROLE ${role} TO USER EXAMPLEADMIN;
USE ROLE ${role};
CREATE SERVICE IF NOT EXISTS ${service}
 IN COMPUTE POOL ${pool}
 FROM SPECIFICATION $$${JSON.stringify(spec)}$$
 EXTERNAL_ACCESS_INTEGRATIONS=(PERSONAL_PHOTOS_UPLOAD_EAI)
 MIN_INSTANCES=${settings.minInstances} MAX_INSTANCES=${settings.maxInstances} AUTO_RESUME=FALSE;
GRANT SERVICE ROLE ${service}!ALL_ENDPOINTS_USAGE TO ROLE ${d.GATEWAY_ROLE};
-- Run as the provisioning administrator after creating the service:
USE ROLE ACCOUNTADMIN;
ALTER COMPUTE POOL ${pool} SET AUTO_RESUME=FALSE AUTO_SUSPEND_SECS=900;
USE ROLE ${role};
ALTER SERVICE ${service} SET AUTO_RESUME=FALSE;
USE ROLE ACCOUNTADMIN;
GRANT USAGE, MONITOR, OPERATE ON COMPUTE POOL ${pool} TO ROLE ${d.RESOURCE_PERSONAL_PHOTOS_RUNTIME};
GRANT MONITOR, OPERATE ON SERVICE ${service} TO ROLE ${d.RESOURCE_PERSONAL_PHOTOS_RUNTIME};
-- Existing services need ALTER SERVICE ... FROM SPECIFICATION, not CREATE IF NOT EXISTS.
-- Set both pool MAX_NODES and service MAX_INSTANCES when increasing capacity.
SHOW ENDPOINTS IN SERVICE ${service};
`
const out = new URL('./dist/', import.meta.url)
mkdirSync(out, { recursive: true })
writeFileSync(new URL('spec.json', out), JSON.stringify(spec, null, 2) + '\n')
writeFileSync(new URL('provision.sql', out), sql)
console.log('Generated upload spec and provisioning SQL; no infrastructure changed.')
