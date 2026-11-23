import profile from './deployment.json' with { type: 'json' }

const identifiers = [
  'DATABASE',
  'APP_SCHEMA',
  'DATA_SCHEMA',
  'RAW_SCHEMA',
  'IDENTITY_SCHEMA',
  'WAREHOUSE',
  'APP_SERVICE',
  'PHOTO_STAGE',
  'DERIVED_STAGE',
  'PHOTO_SEARCH_SERVICE',
  'EVENT_SEARCH_SERVICE',
  'PHOTO_SEARCH_TABLE',
  'EVENT_SEARCH_TABLE',
  'VIDEO_CONTROL',
  'VIDEO_JOB_CONTROL',
  'IDENTITY_CONTROL',
  'GPU_POOL',
  'LEGACY_GPU_POOL',
  'GATEWAY_USER',
  'GATEWAY_ROLE',
  'RENEWAL_ROLE',
  'GATEWAY_PAT_NAME',
  'GPU_ROLE',
  'GPU_EAI',
  'GPU_SECRET',
  'FACE_POOL',
  'SEARCH_POOL',
  'FACE_ROLE',
  'FACE_LAUNCHER_ROLE',
  'FACE_EAI',
  'FACE_SECRET',
  'FACE_CONTROL',
  'FACE_JOB_CONTROL',
  'IMAGE_REPOSITORY',
  'PG_NETWORK_RULE',
]
export function validateDeployment(value) {
  for (const key of Object.keys(profile)) {
    if (typeof value[key] !== 'string' || !value[key] || /[\r\n\0"'\\{}]/.test(value[key]))
      throw Error(`Invalid deployment setting: ${key}`)
  }
  for (const key of [
    ...identifiers,
    ...Object.keys(value).filter((key) => key.startsWith('RESOURCE_')),
  ])
    if (!/^[A-Z][A-Z0-9_]*$/.test(value[key])) throw Error(`Invalid SQL identifier: ${key}`)
  for (const key of ['SNOWFLAKE_API_ORIGIN', 'APP_ORIGIN', 'GATEWAY_ORIGIN']) {
    const url = new URL(value[key])
    if (
      url.protocol !== 'https:' ||
      url.origin !== value[key] ||
      url.username ||
      url.password ||
      url.port
    )
      throw Error(`Invalid origin: ${key}`)
  }
  if (
    !/^[A-Z0-9]+-[A-Z0-9]+$/.test(value.SNOWFLAKE_ACCOUNT) ||
    new URL(value.SNOWFLAKE_API_ORIGIN).hostname !==
      value.SNOWFLAKE_ACCOUNT.toLowerCase() + '.snowflakecomputing.com'
  )
    throw Error('Snowflake account/API mismatch')
  if (!new URL(value.APP_ORIGIN).hostname.endsWith('.snowflakecomputing.app'))
    throw Error('Invalid application origin')
  for (const key of [
    'GATEWAY_HOST',
    'STORAGE_HOST',
    'RUNTIME_STORAGE_HOST',
    'AUTH0_DOMAIN',
    'AUTH0_MANAGEMENT_DOMAIN',
    'PG_HOST',
    'SMTP_HOST',
  ])
    if (
      !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(value[key]) ||
      !value[key].includes('.') ||
      value[key].includes('..')
    )
      throw Error(`Invalid host: ${key}`)
  if (new URL(value.GATEWAY_ORIGIN).hostname !== value.GATEWAY_HOST)
    throw Error('Gateway host/origin mismatch')
  if (!value.STORAGE_HOST.endsWith('.amazonaws.com')) throw Error('Invalid storage host')
  for (const key of [
    'PG_DATABASE',
    'PG_USER',
    'GPU_PG_USER',
    'FACE_PG_USER',
    'CLI_CONNECTION',
    'PG_SERVICE',
  ])
    if (!/^[A-Za-z0-9_-]+$/.test(value[key])) throw Error(`Invalid setting: ${key}`)
  if (!/^[a-f0-9]{32}$/.test(value.CLOUDFLARE_ACCOUNT_ID)) throw Error('Invalid Cloudflare account')
  for (const key of ['GPU_IMAGE', 'FACE_IMAGE'])
    if (
      !/^\/[a-z0-9_]+\/[a-z0-9_]+\/[a-z0-9_-]+\/[a-z0-9_-]+:[a-z0-9._-]+(?:@sha256:[a-f0-9]{64})?$/.test(
        value[key],
      )
    )
      throw Error(`Invalid worker image: ${key}`)
  // Face scan capacity: the pool size and how many photos one job analyzes at once.
  // Snowflake reports usable workload vCPUs; allow the full allocation.
  // vCPU and GiB available on one node of each family (SHOW COMPUTE POOL INSTANCE FAMILIES).
  const [faceVcpu, faceGib] = {
    CPU_X64_S: [3, 13],
    CPU_X64_M: [6, 28],
    CPU_X64_SL: [14, 58],
    CPU_X64_L: [28, 116],
  }[value.FACE_INSTANCE_FAMILY] ?? [0, 0]
  if (!faceVcpu) throw Error('Invalid setting: FACE_INSTANCE_FAMILY')
  const cpu = Number(value.FACE_WORKER_CPU)
  const parallel = Number(value.FACE_WORKER_PARALLEL)
  if (!/^[0-9]{1,2}$/.test(value.FACE_WORKER_CPU) || cpu < 1 || cpu > faceVcpu)
    throw Error('Invalid setting: FACE_WORKER_CPU')
  if (!/^[0-9]{1,2}$/.test(value.FACE_WORKER_PARALLEL) || parallel < 1 || parallel > cpu)
    throw Error('Invalid setting: FACE_WORKER_PARALLEL')
  // About 4 GiB per analysis process for large HEIC/panorama decodes, within 85% of the node.
  const memory = Math.min(Math.floor(faceGib * 0.85), Math.max(4, cpu * 4))
  return Object.freeze({ ...value, FACE_WORKER_MEMORY: `${memory}Gi` })
}
export const deployment = validateDeployment(profile)
export const objectName = (schema, name) => `${deployment.DATABASE}.${schema}.${name}`
export const objects = Object.freeze({
  originals: objectName(deployment.RAW_SCHEMA, deployment.PHOTO_STAGE),
  derived: objectName(deployment.RAW_SCHEMA, deployment.DERIVED_STAGE),
  photoSearch: objectName(deployment.DATA_SCHEMA, deployment.PHOTO_SEARCH_SERVICE),
  eventSearch: objectName(deployment.DATA_SCHEMA, deployment.EVENT_SEARCH_SERVICE),
  photoSearchTable: objectName(deployment.DATA_SCHEMA, deployment.PHOTO_SEARCH_TABLE),
  eventSearchTable: objectName(deployment.DATA_SCHEMA, deployment.EVENT_SEARCH_TABLE),
  videoControl: objectName(deployment.APP_SCHEMA, deployment.VIDEO_CONTROL),
  faceControl: objectName(deployment.APP_SCHEMA, deployment.FACE_CONTROL),
  identityControl: objectName(deployment.IDENTITY_SCHEMA, deployment.IDENTITY_CONTROL),
  appService: objectName(deployment.APP_SCHEMA, deployment.APP_SERVICE),
})
