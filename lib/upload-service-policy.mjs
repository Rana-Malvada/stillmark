/** Exact paths only: neither UI pages nor administrative APIs belong on upload ingress. */
export function isUploadServiceRoute(path, method) {
  return (
    (path === '/api/upload/chunk' && ['GET', 'POST', 'DELETE'].includes(method)) ||
    (path === '/api/upload/complete' && method === 'POST')
  )
}
export function uploadServiceRequestAllowed(path, method) {
  return (
    isUploadServiceRoute(path, method) ||
    (path === '/api/upload/status' && method === 'POST') ||
    (['/api/health/live', '/api/health/upload-ready'].includes(path) && method === 'GET')
  )
}
