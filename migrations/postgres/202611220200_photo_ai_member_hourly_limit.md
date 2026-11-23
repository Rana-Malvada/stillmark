# Member hourly allowance for automatic photo descriptions

Adds a separate hourly allowance for automatic AI descriptions of photos owned by
ordinary members. Main admins and holders of an administrator role (`admin` or
`app_owner` profile) keep the general per-owner allowance. The application sets the
member allowance with `PHOTO_AI_MEMBER_MAX_CLAIMS_PER_HOUR` (production: 10).

The allowance counts claims per album owner per clock hour (UTC), exactly as the
existing per-owner allowance does: retries, abandoned attempts and same-file reuse
all consume it. Photos beyond the allowance are not rejected or lost. They stay
queued and are described in later hours, so a large member upload is described
gradually. Uploading, viewing, sharing and search of already described photos are
unaffected.

`photo_security.photo_ai_unlimited_owners()` is a SECURITY DEFINER read of the
main-admin list and role memberships, executable only by the maintenance role. It
returns usernames only. `claim_photo_ai` gains a six-argument form; the
five-argument form is kept as a wrapper that passes the general allowance for
every owner, so the previous application version behaves exactly as before.

Deploy this additive migration before the application. If the application is
rolled back, keep the migration installed: the old code calls the five-argument
form. No rows, table types, grants on existing objects or leases are changed.

Verification: `tests/photo-ai-admission.test.ts` covers the member allowance, the
administrator and main-admin exemptions, the next-hour release, the unchanged
five-argument behavior, invalid limits and denied application-role execution.
`npm run test:ai-admission-postgres` repeats the allowance check against disposable
native PostgreSQL.

Read-only installation check:

```sql
SELECT pg_get_functiondef('public.claim_photo_ai(uuid,int,int,int,int,int)'::regprocedure);
```
