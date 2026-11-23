import { recordLoadTestRequest } from './lib/load-test-request-journal'
import { uploadServiceRequestAllowed } from './lib/upload-service-policy.mjs'
import { RESOURCE_POLICY } from './lib/content-policy.mjs'
import { NextRequest, NextResponse } from 'next/server'
/** Early rejection only. Server auth additionally verifies the runtime token. */
export function proxy(req: NextRequest) {
  recordLoadTestRequest(req.headers.get('x-load-test-request'), { proxyAt: Date.now() })
  if (
    process.env.UPLOAD_SERVICE_ONLY === 'true' &&
    !uploadServiceRequestAllowed(req.nextUrl.pathname, req.method)
  )
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (process.env.UPLOAD_SERVICE_ONLY === 'true' && !req.headers.get('x-photo-gateway-identity'))
    return NextResponse.json({ error: 'Gateway authentication required' }, { status: 401 })
  const development = process.env.NODE_ENV === 'development' && process.env.DEV_AUTH === 'true'
  if (
    !development &&
    (!req.headers.get('sf-context-current-user') ||
      !req.headers.get('sf-context-current-user-token'))
  ) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const headers = new Headers(req.headers)
  headers.delete('x-nonce')
  headers.delete('Content-Security-Policy')
  headers.delete('Content-Security-Policy-Report-Only')
  // Overwrite untrusted client values before server authorization.
  headers.set('x-photo-request-method', req.method)
  headers.set('x-photo-request-target', req.nextUrl.pathname + req.nextUrl.search)
  if (
    !req.nextUrl.pathname.startsWith('/api/') &&
    !req.nextUrl.pathname.startsWith('/share/') &&
    req.headers.get('accept')?.includes('text/html')
  ) {
    const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
    const policy = `${RESOURCE_POLICY}; frame-ancestors 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}; script-src-attr 'none'; object-src 'none'; base-uri 'self'; report-uri /api/csp-report`
    // Next extracts the nonce from the request policy when rendering its scripts.
    headers.set('Content-Security-Policy', policy)
    headers.set('x-nonce', nonce)
    const response = NextResponse.next({ request: { headers } })
    response.headers.set('Content-Security-Policy', policy)
    return response
  }
  return NextResponse.next({ request: { headers } })
}
export const config = {
  matcher: [
    // These API routes bind requests and enforce upload-service isolation in withBrowseRequest.
    '/((?!api/(?:events(?:/[0-9]+)?|photos/[0-9]+|images)/?$|_next/static|_next/image|favicon.ico|icon.svg|api/health/live|api/health/upload-ready).*)',
  ],
}
