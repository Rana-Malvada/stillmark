# My travels

Entry point: `/travels`, beside My Albums in the main navigation. This is a read-only exploration page, with existing album and photo pages as the destinations for actions.

## Experience

- Defaults to albums owned by the signed-in user. “Albums I can access” includes shared gallery albums, invitations and the existing App Owner override.
- Year selector uses capture dates in UTC, with All years and Date unknown.
- Summary cards show approximate mapped areas, recorded countries, located files, and albums in the selected view.
- Map markers and accessible place buttons select an area. The detail panel links to the contributing albums and a representative photo.
- Valid coordinates are grouped at 0.1 degrees. These are approximate areas, not inferred trips or exact city boundaries. Country/city names use saved metadata or the optional cached place lookup described below.
- Missing GPS and missing capture dates are explicit. Video records participate when they have GPS metadata. Both maps support trackpad pinch zoom.

## Boundaries and extension points

`lib/travel/travels.ts` is the authorized Postgres read model. It uses the existing album-access functions and aggregates metadata before returning it. `/api/travels` authenticates first and returns private/no-store responses. No scheduled jobs, migrations or Snowflake usage queries were added. Existing auth and media delivery mechanisms still apply.

`lib/travel/travel-overview.ts` is the pure summary/filter model; `components/travels-panel.tsx` owns the overview interaction, while `components/travel-map.tsx` owns Leaflet rendering. New map modes, geocoding, travel timelines or location correction can extend these separately, without adding administration behavior to this read-only page.

Map tiles come directly from CARTO Positron in the browser when the `CARTO_BASEMAPS` secret is mounted (production); without it the authenticated OpenStreetMap proxy is the fallback. Attribution is shown in both cases. No tile prefetch or offline download is introduced. Missing tiles do not prevent use of the place list. Country totals reflect recorded metadata, not a verified country count. Coordinate grid boundaries can split nearby photos into separate areas. No route inference or travel mileage is claimed.

## Verification

Test ownership, invitations, administrator access, missing coordinates and valid
zero coordinates. Browser checks should exercise map loading, area selection,
album links, year filters and overflow on mobile/desktop. Live checks are separate
from synthetic fixtures; keep results privately in `.release/`.

## On-demand place names

“Find place names” resolves up to 12 currently unnamed areas per user click. Requests stop when the page is left; no periodic job is scheduled. The backend verifies album access before accepting an area, sends only the existing rounded area coordinates, and caches the locality/region/country in Postgres. Saved photo metadata remains unchanged and takes precedence. Country summary cards can use cached lookup countries.

The public OpenStreetMap Nominatim endpoint needs no API key. A global advisory lock and durable two-second cooldown apply across users/replicas. Successful results are reused indefinitely; no-result responses are deferred seven days unless explicitly retried. Transient failures are not cached as nameless results. HTTP 403/429 responses apply a shared one-hour provider cooldown. No arbitrary coordinate lookup endpoint is exposed.

Provider configuration is in `travel_lookup_settings` (administrator-only database access): set enabled=false to disable outbound lookups while keeping cached names. The HTTPS endpoint is configurable without changing application code; changing hosts also requires updating the Snowflake egress allowlist. Attribution and the provider usage policy are linked in the page. No systematic grid crawling, autocomplete, scheduled lookup or per-photo external request is performed.

Migrations: Postgres `26-travel-place-cache.sql`; Snowflake `27-travel-place-network.sql`; manifest includes PERSONAL_PHOTOS_TRAVEL_EAI. Labels describe approximate areas and may name a neighboring town because coordinates are rounded. The country count remains metadata-based rather than a verified border calculation.

## Map gestures

Both the travel map and individual-photo map use `components/map-gestures.tsx` for desktop trackpad pinch zoom. Ctrl-wheel pinch events and Safari gesture events zoom around the pointer with fractional zoom levels. Ordinary wheel scrolling stays native so the map does not trap page scrolling. Leaflet handles touchscreen pinch; drag and zoom buttons remain available. Listeners and pending animation frames are removed on unmount.

Verify pinch in/out, ordinary scroll passthrough and Safari gesture handling. Synthetic browser gestures do not prove behavior on a physical trackpad.

Place lookup saves successful names and caches successful nameless results for seven days. If only previously checked unnamed areas remain, **Retry unnamed areas** explicitly checks them again. Failed provider requests are reported as failures and do not create nameless cache records. All retries retain the shared two-second request spacing and provider refusal/rate-limit cooldown. Only areas visible to the signed-in viewer can be looked up.
