# Video preparation exclusions

Adds a default-false flag and a nullable original-path snapshot. Apply before deploying the new app. No existing jobs or
originals change. Only terminal failed files may be excluded; changes are blocked
during an active preparation run. Exclusions follow the original path and are
cleared when a replacement original is queued. Restore permits the next explicit
Prepare videos operation to retry.

Verify with video-preparation and video-preparation-api tests. Roll back app code
while retaining the additive column; older apps do not honor exclusions, so do
not launch preparation from an older version if exclusions must remain enforced.
No data deletion is needed.
