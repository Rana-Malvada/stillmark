# Fenced chunk storage without long transactions

Additive table; existing app versions continue to use `upload_chunks`. The new
app reserves an owner-scoped chunk attempt, releases the transaction, writes to a
unique stage path with an existing durable cleanup intent, and publishes only if
the same token still owns the unexpired reservation and the session is unsealed.
Session deletion cascades reservations, fencing cancellation/recreation races.
Expired reservations may be replaced; stale writers cannot publish or delete a
replacement token. Failed attempts release their own reservation only.

Apply before deploying the app/upload worker. Do not roll back this table while
the new worker is running. The previous runtime remains compatible with it.
Verify `SELECT count(*) FROM public.upload_chunk_writes` and role grants/RLS.
Local database tests cover duplicate retries, cancellation/recreation, token
replacement, storage failure, owner isolation, and no transaction during storage.

The existing stage-cleanup intent remains responsible for unpublished files;
no new warehouse query or cleanup mechanism is introduced.
