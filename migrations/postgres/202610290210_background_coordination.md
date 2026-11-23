# Background leadership and assertion expiry

Adds a maintenance-only coordinator lease and a maintenance-only bounded
assertion cleanup function. The application still atomically consumes each
assertion and retains the same expiry/replay margin. Only expiry housekeeping
moves to the elected background coordinator; assertions are not cached or reused.

Old app code is compatible during rollout, but does not call the new cleanup
function. Deploy promptly after migration; delayed cleanup retains replay records
and consumes storage, rather than admitting expired assertions. A rollback must
retain a scheduled call to `photo_security.cleanup_gateway_assertions()` until
request-path housekeeping is restored through a new migration.

The maintenance credential alone can acquire leadership or clean assertions.
The 30-second database lease is renewed every 10 seconds with a conservative
20-second local dispatch window. Existing individual job locks and fencing remain
in force for in-flight work during failover. `BACKGROUND_EXECUTION_ROLE=web`
allows a deployment with a separate scheduler to disable web-instance polling;
the existing deployment continues automatic leader election.

Verification: inspect the coordinator lease; execute cleanup as maintenance;
confirm application-role cleanup and coordinator access are denied and live
duplicate assertions remain rejected. Local SQL tests cover those boundaries.
