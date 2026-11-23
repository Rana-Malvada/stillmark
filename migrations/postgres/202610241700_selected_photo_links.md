# Selected-photo public links

Adds nullable photo_ids to each link (1–200 IDs for a selection, NULL for whole
album). Existing links retain whole-album behavior, including future uploads.
New selections are validated and saved atomically against the editable album.
Photos deleted or moved out of that album disappear from the shared selection;
an empty remaining selection never becomes whole-album access.

Apply before deploying the new runtime using the migration runner. No production
migration is applied while deployment is on hold. The schema is backward compatible
with the previous app. Keep this migration in place on application rollback:
photo RLS limits even old list, media, detail and ZIP routes to selected IDs.
The read_photo helper and public_photo_people security-definer also enforce the
selection. Do not remove the policy/column while any selected link is active.

Verify with selected-photo-links RLS tests, including guessed IDs, original/video
paths, ZIP/list queries, names, revocation, expiration, transfers and later uploads.
No Snowflake warehouse is involved. This migration only changes PostgreSQL schema
and access policy, with short lock timeout so uploads are not held behind DDL.
