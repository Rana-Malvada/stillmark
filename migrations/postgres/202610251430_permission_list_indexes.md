# Indexed permission-list paths

Follow-up to `202610251400_album_permission_queries.sql`. Uses separate branches
for main-admin, owned, gallery, explicitly shared and public-link albums. UNION
keeps readable IDs unique; editable branches are mutually exclusive. Existing
owner/share/primary-key indexes serve targeted lookups; the new partial gallery
index avoids scanning private albums to find gallery-visible ones.

The index is created transactionally with the migration and a five-second lock
acquisition timeout. Review table size and use a planned migration window before
production; a large table may require a separately managed concurrent index build.
Do not assume future million-user index builds can run inside this migration.

Rollback: restore the two function definitions from the preceding migration and
drop only `public.events_gallery_read`. No data or permission membership changes.
