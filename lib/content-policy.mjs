// Where a page may load each kind of resource from. Shared by the request proxy,
// which sends it with every HTML document, and by its tests. Script rules are added
// per request in proxy.ts because they carry a fresh nonce.
//
// Verified against the live site before being enforced: every screen, map tiles,
// thumbnails and video playback loaded with no violation under this policy.
export const RESOURCE_POLICY = [
  "default-src 'self'",
  // Photos and thumbnails are same-origin; previews use blob and data URLs; map tiles
  // come from the one external host.
  "img-src 'self' data: blob: https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com",
  // Adaptive video playback feeds the player through blob URLs.
  "media-src 'self' blob:",
  "connect-src 'self'",
  // The framework and components set inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "form-action 'self'",
].join('; ')
