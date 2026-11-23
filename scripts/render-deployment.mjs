import { renderDeployment } from '../config/render.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deployment } from '../config/deployment.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = [
  'app.yml',
  'cloudflare-gateway/wrangler.jsonc',
  'workers/video-gpu/production-spec.json',
  'workers/video-gpu/provision.sql',
  'workers/face-cpu/production-spec.json',
  'workers/face-cpu/provision.sql',
  'workers/search-cpu/provision.sql',
]
for (const file of files) {
  const template = readFileSync(resolve(root, 'config/templates', file), 'utf8')
  const rendered = renderDeployment(template, deployment)
  if (process.argv.includes('--write')) writeFileSync(resolve(root, file), rendered)
  else if (rendered !== readFileSync(resolve(root, file), 'utf8'))
    throw Error(`Deployment drift: ${file}; run npm run config:render`)
}
console.log('Deployment configuration validated; manifests match the profile')
