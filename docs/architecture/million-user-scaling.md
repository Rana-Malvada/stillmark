# Stillmark scaling program

> **Planning document.** One million registered users and 100,000 concurrent users is a
> design objective. It has **not been measured or demonstrated**; production runs a
> single small deployment. Nothing here is a capacity claim.

## Production baseline

The current deployment is documented in [production operations](../PRODUCTION.md).
The design objective remains one million registered users and 100,000 concurrent
users. That objective does not set production replica counts.

- Interactive requests run in Snowflake App Runtime behind the Auth0/Cloudflare gateway.
- Upload transfer and durable processing run in a separate CPU_X64_XS compute pool.
- Upload concurrency derives from configured and detected CPU/memory budgets.
- PostgreSQL holds permissions, catalog state, leases, queues and publication records.
- Media resides in Snowflake internal stages. Description inference uses Cortex REST.
- Face scanning, video preparation and search enrichment use separate finite batch workers.
- Production upload automatic scale-out is disabled; startup and fifteen-minute idle
  suspension are controlled by durable lifecycle state.

## Capacity work

Measure the actual browsing/upload mix before changing resource bounds. Keep test
infrastructure isolated from production, use explicit connection budgets, and record
first-request failures separately from startup time and steady-state latency.

1. Validate one application instance with fixed database and worker resources.
2. Increase concurrent clients gradually with latency, error and queue-age gates.
3. Compare application replica counts while holding the other resources steady.
4. Validate worker recovery, publication uniqueness and lifecycle behavior under load.
5. Enable automatic scaling only for an image with matching reviewed evidence.
6. Introduce owner-based database sharding when measurements justify it, keeping
   each owner's upload queue and catalog publication transaction on the same shard.

Read replicas, multiple cells and automated shard placement belong to the
[architecture design](stillmark-target-state.md), not the current production topology.
The [load harness](../../scripts/load-test/README.md) and
[upload validation procedure](../../workers/upload-cpu/validation/README.md) define
controlled tests. Historical results are version-specific and remain in Git history.
No test is started by this document.
