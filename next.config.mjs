// `output: "standalone"` is required for Docker/SPCS deployment.
// Media delivery handles image variants; disable the Next.js image optimizer.
//
// `turbopack.root` and `outputFileTracingRoot` are pinned to this app's
// own directory because Next.js 16 + Turbopack walks upward looking for
// a lockfile and silently re-roots the project if it finds one in a
// parent directory. Symptoms when this re-roots are nasty: `/` returns
// 404, chunk URLs contain the wrong path prefix, and
// `outputFileTracingRoot` is wrong at deploy time. Keeping these
// pinned to `__dirname` is the only reliable fix; do NOT remove them
// when adding new config.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Gateway assertions bind the original URL, including Next's _rsc navigation key.
  skipProxyUrlNormalize: true,
  serverExternalPackages: [
    'snowflake-sdk',
    'ffmpeg-static',
    'ffprobe-static',
    '@huggingface/transformers',
    'onnxruntime-node',
    // The OTLP exporter dynamically requires gRPC. Keep its Node dependency tree
    // intact so standalone workers can export metrics after deployment.
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/resources',
    '@opentelemetry/exporter-metrics-otlp-grpc',
  ],
  // The SDK loads this helper through eval('require'), invisible to static tracing.
  // Omitting it causes a native-load error and extra telemetry after every login.
  outputFileTracingIncludes: {
    '/*': ['./node_modules/snowflake-sdk/dist/lib/minicore/binaries/*.node'],
  },
  outputFileTracingRoot: __dirname,
  turbopack: {
    root: __dirname,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
          },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
    ]
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    proxyClientMaxBodySize: '50mb',
  },
}

export default nextConfig
