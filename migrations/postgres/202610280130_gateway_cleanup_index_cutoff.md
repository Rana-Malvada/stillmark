# Indexed replay-claim expiry cleanup

Use `statement_timestamp()` for the housekeeping cutoff in the existing bounded `SKIP LOCKED` cleanup. PostgreSQL can turn that stable value into an expiry-index condition. The old volatile `clock_timestamp()` expression required filtering live claim rows while scanning the expiry index.

Assertion admission still checks the actual wall clock with `clock_timestamp()`, retains the same 35-second upper bound and five-second replay-retention margin, and atomically rejects duplicate IDs. A claim that expires during a statement may remain until the next cleanup; this conservatively retains replay protection longer. Logout and account permission checks are unchanged.

Tests exercise both the legacy and optimized functions for concurrent duplicate claims, expired assertions, protected table access, and invalidation privileges. An additional test confirms cleanup deletes expired claims while retaining and rejecting reuse of live claims. No application rebuild or global database setting is required.
