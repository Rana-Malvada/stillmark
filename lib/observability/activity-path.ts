// Shared by the browser queue and server validation. Never record query strings,
// arbitrary URLs, API routes, or public share tokens.
const PAGE =
  /^\/(?:events\/\d+(?:\/slideshow)?|photos\/\d+|people(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?|account|my-albums|costs|travels|favorites|search|trash|activity\/shared-links|admin\/(?:processing|upload-processing|upload|activity|costs|access|users-activity|scan-people|prepare-videos|update-search|video-analysis))?$/i

export function isActivityPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 120 && PAGE.test(path)
}
