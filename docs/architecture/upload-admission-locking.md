# Upload concurrency controls

Uploads to an existing album take a **shared** transaction advisory lock on
`photo-management`, followed by the existing exclusive album advisory lock.
Different albums can publish concurrently, while same-album counts, cover selection
and duplicate handling remain serialized. Album discovery/creation retains the
exclusive management lock; there is no shared-to-exclusive upgrade.

Management operations retain their exclusive management barrier. Deletes, moves,
folder mutations and ownership changes therefore still exclude upload validation
and publication. Authorization and album existence are checked again after media
preparation, inside the publication transaction. Lease fencing, atomic catalog and
replay publication, and the durable processing queue are unchanged. Old workers
remain compatible during rollout but still serialize other publication while they
hold their exclusive lock.

Incoming chunk requests may wait FIFO for local receive capacity for at most ten
seconds. The waiting list is limited to 16 times local chunk capacity, capped at
1,024 requests. At the current eight-slot default that is at most 128 waiting
requests. Waiting callbacks do not read or parse request bodies until admitted;
this does not promise that proxies or the HTTP runtime buffer zero bytes. The
existing active-body limit remains in effect. Queue overflow or expiry returns 429
with Retry-After. Cancellation removes a waiter, and capacity is reserved before
waking it so new arrivals cannot overtake it. Work already admitted releases its
slot in `finally`, including errors.

This is per-instance admission smoothing, not a distributed fair scheduler or proof
of large-scale capacity. The shared management barrier still blocks all uploads
when an exclusive management operation holds it; broad management work needs
separate measurement before further narrowing its locking scope.

Validation includes cancellation, FIFO ordering, waiting-list bounds, expiry,
authorization recheck, atomic publication/lease fencing, and a three-session real
Postgres check (`scripts/load-test/check-upload-locks.mjs`). Load comparisons use
fixed instance counts with automatic scaling disabled and no production changes.

The October 25 isolated validation encountered deployment setup failures before the
final comparison: a build role lacked artifact-publish access, control-plane status
preceded HTTP readiness, and an initial worker image used the normal build context
instead of the isolated configuration. These runs must remain separate from capacity
results. The corrected image was inspected for isolated database constants and the
shared lock implementation before rollout; no production deployment was performed.
