# Remove the withdrawn member description allowance

`202611220200_photo_ai_member_hourly_limit.sql` added a separate hourly allowance
for members' automatic photo descriptions. The allowance was withdrawn the same
day: members are bounded by their total upload allowance instead, and the
application no longer passes a member allowance.

This migration restores `claim_photo_ai(uuid,int,int,int,int)` to the body from
`202611212350_photo_ai_claim_types.sql` and drops the six-argument form and
`photo_security.photo_ai_unlimited_owners()`. `CREATE OR REPLACE` keeps the
five-argument function's owner and grants. No table or row is changed.

Apply only after an application version that calls the five-argument claim is
live; the version before it called the six-argument form. If the application is
rolled back to that earlier version, photo descriptions pause with an error until
it is rolled forward again; no data is lost and uploads are unaffected.

Verification: `tests/photo-ai-admission.test.ts` applies this migration after its
predecessors and checks that only the five-argument plpgsql function remains with
its grants, and that fairness, concurrency, budgets and leases behave as before.
`npm run test:ai-admission-postgres` repeats those checks on native PostgreSQL.

Read-only installation check:

```sql
SELECT oid::regprocedure FROM pg_proc WHERE proname IN ('claim_photo_ai','photo_ai_unlimited_owners');
```
