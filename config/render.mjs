import { validateDeployment } from './deployment.mjs'

export function renderDeployment(template, settings) {
  const validated = validateDeployment(settings)
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in validated)) throw Error(`Missing deployment setting ${key}`)
    return validated[key]
  })
}
