import { validateDeployment } from '../../config/deployment.mjs'

/** Test artifacts are built with this profile, never the production worker image. */
export function isolatedProfile(base, target) {
  if (!/^[A-Z][A-Z0-9]{2,20}$/.test(target.suffix ?? ''))
    throw Error('Invalid isolated stack suffix')
  const prefix = 'STILLMARK_LOADTEST_' + target.suffix
  const origin = new URL(target.appOrigin)
  if (
    origin.origin !== target.appOrigin ||
    origin.protocol !== 'https:' ||
    !origin.hostname.endsWith('.snowflakecomputing.app') ||
    target.appOrigin === base.APP_ORIGIN
  )
    throw Error('Distinct App Runtime origin required')
  if (
    typeof target.pgHost !== 'string' ||
    target.pgHost === base.PG_HOST ||
    !target.pgHost.endsWith('.postgres.snowflake.app')
  )
    throw Error('Distinct managed Postgres host required')
  const p = { ...base }
  const globalNames = [
    'GPU_POOL',
    'LEGACY_GPU_POOL',
    'GATEWAY_USER',
    'GATEWAY_ROLE',
    'RENEWAL_ROLE',
    'GPU_ROLE',
    'GPU_EAI',
    'FACE_POOL',
    'SEARCH_POOL',
    'FACE_ROLE',
    'FACE_LAUNCHER_ROLE',
    'FACE_EAI',
    ...Object.keys(p).filter((k) => k.startsWith('RESOURCE_')),
  ]
  for (const key of globalNames) p[key] = `${prefix}_${key.replace(/^RESOURCE_/, '')}`
  Object.assign(p, {
    DATABASE: prefix,
    APP_SERVICE: prefix + '_APP',
    PACKAGE_NAME: prefix,
    APP_ORIGIN: target.appOrigin,
    GATEWAY_ORIGIN: target.appOrigin,
    GATEWAY_HOST: origin.hostname,
    PG_HOST: target.pgHost,
    PG_DATABASE: prefix.toLowerCase(),
    PG_SERVICE: prefix.toLowerCase(),
    CLI_CONNECTION: base.CLI_CONNECTION,
    GATEWAY_WORKER_NAME: prefix.toLowerCase().replaceAll('_', '-'),
    METRICS_DATASET: prefix.toLowerCase(),
    AUTH0_DOMAIN: 'disabled.example.invalid',
    AUTH0_MANAGEMENT_DOMAIN: 'disabled.example.invalid',
    AUTH0_CLIENT_ID: 'disabled',
    AUTH0_GALLERY_CLIENT_ID: 'disabled',
    SMTP_HOST: 'disabled.example.invalid',
    GPU_IMAGE: `/${prefix.toLowerCase()}/app/photos_repo/disabled-video:disabled`,
    FACE_IMAGE: `/${prefix.toLowerCase()}/app/photos_repo/disabled-face:disabled`,
  })
  // Warehouse operations are explicitly addressed to a dedicated test warehouse.
  p.WAREHOUSE = prefix + '_WH'
  return validateDeployment(p)
}

export function isolatedAppManifest(p) {
  if (
    !p.DATABASE.startsWith('STILLMARK_LOADTEST_') ||
    !p.PG_DATABASE.startsWith('stillmark_loadtest_')
  )
    throw Error('Isolated profile required')
  const scope = `${p.DATABASE}.${p.APP_SCHEMA}`
  return {
    version: 2,
    min_instances: 1,
    max_instances: 1,
    auto_resume: false,
    auto_suspend_secs: 300,
    name: p.APP_SERVICE,
    artifact_repo: `${scope}.${p.RESOURCE_PERSONAL_PHOTOS_REPO}`,
    package_name: p.PACKAGE_NAME,
    database: p.DATABASE,
    schema: p.APP_SCHEMA,
    query_warehouse: p.WAREHOUSE,
    build_eai: p.RESOURCE_PERSONAL_PHOTOS_BUILD_EAI,
    external_access_integrations: [p.RESOURCE_PERSONAL_PHOTOS_EAI],
    secrets: [
      { name: 'PG_UPLOAD_QUEUE', secret: `${scope}.PG_UPLOAD_QUEUE_SECRET` },
      { name: 'PG_SECRET', secret: `${scope}.${p.RESOURCE_PG_APP_SECRET}` },
    ],
    environment_variables: Object.entries({
      SF_TELEMETRY_DISABLE_CONNECTION_SHAPE: 'true',
      APP_ORIGIN: p.APP_ORIGIN,
      PG_HOST: p.PG_HOST,
      PG_DATABASE: p.PG_DATABASE,
      PG_PORT: '5432',
      PG_USER: p.PG_USER,
      PG_SSL: 'true',
      PG_SSL_ROOT_CERT: 'certs/postgres-root.crt',
      BACKGROUND_JOBS_ENABLED: 'false',
      AUTH0_MANAGEMENT_ENABLED: 'false',
      GATEWAY_AUTH_ENABLED: 'false',
      VIDEO_CONVERSION_ENABLED: 'false',
      VIDEO_STREAMING_ENABLED: 'false',
      UPLOAD_PROCESSING_QUEUE_ENABLED: 'true',
      UPLOAD_PROCESSING_WORKER_ENABLED: 'false',
      UPLOAD_ROUTING_MANAGED: 'false',
      UPLOAD_COMPLETIONS_PER_INSTANCE: '2',
    }).map(([name, value]) => ({ name, value })),
    install: { commands: [['env', 'ONNXRUNTIME_NODE_INSTALL=skip', 'npm', 'ci', '--include=dev']] },
    build: {
      commands: [
        ['npm', 'run', 'build'],
        ['cp', '-r', '.next/static', '.next/standalone/.next/static'],
        ['cp', '-r', 'public/.', '.next/standalone/public'],
        ['cp', '-r', 'certs', '.next/standalone/certs'],
        ['node', 'scripts/copy-video-tools.cjs'],
        ['rm', '-rf', 'node_modules'],
      ],
    },
    run: { command: ['node', '.next/standalone/server.js'] },
    profile: {
      label: 'Stillmark isolated upload test',
      description: 'Synthetic uploads only; background jobs disabled',
    },
    ignore: [
      'workers',
      'tests',
      'cloudflare-gateway',
      '.deployment-backups',
      '.load-tests',
      'node_modules',
      '.env*',
      '.next',
      '.git',
      '*.log',
      'output',
      '.release',
    ],
  }
}

export function isolatedWorkerSpec(p, image) {
  const prefix = `/${p.DATABASE.toLowerCase()}/${p.APP_SCHEMA.toLowerCase()}/${p.IMAGE_REPOSITORY.toLowerCase()}/upload-worker:`
  if (
    !image.startsWith(prefix) ||
    !/^[a-z0-9_/.:-]+$/.test(image) ||
    image.length === prefix.length
  )
    throw Error('Worker image must be built in the isolated repository')
  const scope = `${p.DATABASE}.${p.APP_SCHEMA}`
  return {
    spec: {
      containers: [
        {
          name: 'upload',
          image,
          env: {
            UPLOAD_SERVICE_ONLY: 'true',
            BACKGROUND_JOBS_ENABLED: 'false',
            GATEWAY_AUTH_ENABLED: 'false',
            UPLOAD_PROCESSING_QUEUE_ENABLED: 'true',
            UPLOAD_PROCESSING_WORKER_ENABLED: 'true',
            UPLOAD_ROUTING_MANAGED: 'false',
            UPLOAD_QUEUE_DIAGNOSTICS: 'true',
            UPLOAD_COMPLETIONS_PER_INSTANCE: '2',
            UPLOAD_RESOURCE_CPU: '1',
            UPLOAD_RESOURCE_MEMORY_MIB: '5120',
            PG_HOST: p.PG_HOST,
            PG_DATABASE: p.PG_DATABASE,
            PG_USER: p.PG_USER,
            PG_SSL: 'true',
            PG_SSL_ROOT_CERT: '/app/certs/postgres-root.crt',
            SNOWFLAKE_ACCOUNT: p.SNOWFLAKE_ACCOUNT,
            SNOWFLAKE_DATABASE: p.DATABASE,
            SNOWFLAKE_SCHEMA: p.APP_SCHEMA,
          },
          secrets: [
            {
              snowflakeSecret: `${scope}.PG_UPLOAD_QUEUE_SECRET`,
              directoryPath: '/secrets/PG_UPLOAD_QUEUE',
            },
            {
              snowflakeSecret: `${scope}.${p.RESOURCE_PG_APP_SECRET}`,
              directoryPath: '/secrets/PG_SECRET',
            },
          ],
          resources: { requests: { cpu: 1, memory: '5Gi' }, limits: { cpu: 1, memory: '5Gi' } },
          readinessProbe: { port: 3000, path: '/api/health/upload-ready' },
        },
      ],
      endpoints: [{ name: 'upload', port: 3000, public: false }],
    },
  }
}

/** Keep platform-managed artifact traffic out of the external-access proxy route. */
export function isolatedNetworkRulesSql(p) {
  if (
    !/^STILLMARK_LOADTEST_[A-Z0-9_]+$/.test(p.DATABASE ?? '') ||
    !/^[A-Z][A-Z0-9_]*$/.test(p.APP_SCHEMA ?? '') ||
    !/^[a-z0-9.-]+\.postgres\.snowflake\.app$/.test(p.PG_HOST ?? '') ||
    !/^[a-z0-9.-]+\.amazonaws\.com$/.test(p.STORAGE_HOST ?? '') ||
    p.STORAGE_HOST.startsWith('spcs-ap-')
  )
    throw Error('Invalid isolated network profile')
  const scope = `${p.DATABASE}.${p.APP_SCHEMA}`
  return `-- Isolated external dependencies only. Do not add RUNTIME_STORAGE_HOST here.
-- Listing the managed artifact access point here caused bootstrap S3 access denial.
CREATE NETWORK RULE ${scope}.PG_EGRESS MODE=EGRESS TYPE=HOST_PORT
 VALUE_LIST=('${p.PG_HOST}:5432');
CREATE NETWORK RULE ${scope}.STAGE_EGRESS MODE=EGRESS TYPE=HOST_PORT
 VALUE_LIST=('${p.STORAGE_HOST}:443');
`
}
