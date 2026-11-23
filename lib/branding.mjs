// Shared by Next metadata, public album HTML, and the gateway sign-in page.
export const BRAND_ICON_VERSION = 'stillmark-amber-1'
export const BRAND_ICONS = {
  icon: [
    { url: `/favicon.ico?v=${BRAND_ICON_VERSION}`, sizes: 'any' },
    { url: `/icon.svg?v=${BRAND_ICON_VERSION}`, type: 'image/svg+xml' },
  ],
  apple: `/apple-touch-icon.png?v=${BRAND_ICON_VERSION}`,
}
export const BRAND_ICON_LINKS = `<link rel="icon" href="${BRAND_ICONS.icon[0].url}" sizes="any"><link rel="icon" href="${BRAND_ICONS.icon[1].url}" type="image/svg+xml"><link rel="apple-touch-icon" href="${BRAND_ICONS.apple}">`

const PUBLIC_BRANDING_PATHS = new Set([
  '/favicon.ico',
  '/icon.svg',
  '/apple-touch-icon.png',
  '/app-icon-512.png',
  '/site.webmanifest',
])
export function isPublicBrandingRequest(pathname, method) {
  return (method === 'GET' || method === 'HEAD') && PUBLIC_BRANDING_PATHS.has(pathname)
}
