# Live upload validation

This optional operator-run producer uses the real staged upload, admission, duplicate replay,
queue claim and publication paths. It is not an HTTP route and is never started by the app.

Run `node workers/upload-cpu/validation/build.mjs` from the repository root. Package the
result as a finite job on an upload-worker image. Use the upload role, existing app and
restricted queue secrets, and upload EAI; do not place credentials in the image or source.

Required: `VALIDATE_OWNER` (existing main administrator) and `VALIDATE_EVENT_ID` (isolated,
private album whose name begins `__upload_validation_`). `VALIDATE_COUNT` is bounded 1–80.
`VALIDATE_MODE=enqueue` stages synthetic JPEGs and queues each twice to check acceptance
idempotence, then exits. Verify completion separately in Postgres; exit is not proof of
publication. Check unique result/photo/action counts, attempts and errors.

`VALIDATE_MODE=abandon` refuses unrelated pending jobs, claims one isolated job plus its
completion lease, then exits without releasing either. Hold regular pool consumers briefly
while creating this claim, then restore them. Wait the real five-minute timeout and verify
one publication on the second attempt. Do not shorten production leases.

For scale-out, temporarily fix service MIN_INSTANCES=MAX_INSTANCES=2 (automatic scaling
stays off). Permit enough compute nodes for both workers and the producer. Enable
UPLOAD_QUEUE_DIAGNOSTICS only during the test; collect bounded logs from each worker and
verify both claimed distinct jobs. Verify pending jobs prevent idle suspension, then verify idle suspension and resume.
Restore normal bounds and remove only the isolated test fixtures when finished.

Set `UPLOAD_SCALING_EVIDENCE` to a private JSON file when rendering enabled scaling.
This is a release gate, not a claim that missing tests passed. Match its `image` to
the exact configured immutable image and `report` to a reviewed private report. The renderer rejects scaling when the
proof is missing/stale or its tested instance count is below the configured maximum.
Browser disconnect/reopen and real mixed-media soak tests remain separate from this
server-side producer test. This suite does not establish 100,000-user capacity.

## Isolated automatic scaling controller test

Run `node workers/upload-cpu/validation/render-autoscaling-test.mjs`. Review and promptly
execute the generated `dist/autoscaling-test/create.sql`. It creates only
`STILLMARK_UPLOAD_SCALE_TEST` (pool) and `PERSONAL_MEDIA.APP.STILLMARK_UPLOAD_SCALE_TEST`
(service), bounded to two CPU_X64_XS nodes. It does not change production routing/settings.
It runs the existing worker image with a separate probe entrypoint and no secrets,
external access integration, public endpoint or media processing.

The probe emits controlled signals through the real OTLP exporter/collector: backlog
until the fixed five-minute deadline, one minute draining, then zero load. Each replica
uses the same absolute deadlines so scaling out does not restart the test phases.
The exact policy produced by the production renderer must be used. Test fixture evidence
only permits rendering this disposable test; it is never copied into production evidence.

Observe service and compute-pool counts through DESCRIBE, initially one, automatically
two, then automatically one after the full ten-minute idle stabilization period. Do not
manually adjust counts during the test. Inspect phase logs and service-attributed metrics.
This validates Snowflake's controller and policy, not high-concurrency media throughput;
real queue distribution and browser recovery are separately validated.

After collecting evidence, drop only this named test service, suspend its pool, wait for
zero active nodes, and drop the test pool. The probe exits after a bounded time as a backup,
but that alone does not guarantee the pool stops billing; always verify infrastructure
cleanup. Keep normal automatic scaling off until all release-gate evidence passes.

Do not mistake `active_nodes=1` for a one-node pool when `idle_nodes=1` and
`target_nodes=2`. Keep observing until active=1, idle=0 and target=1; record node
reclamation separately from worker scale-down. If testing reclamation independently,
start two fixed probe instances, wait for two active nodes, then reduce only the service
to one fixed instance. Leave pool MIN_NODES=1/MAX_NODES=2 untouched and wait for Snowflake
to remove the spare node. This manual worker reduction tests **node reclamation only**,
not native service autoscaling. Never mark either test as proof of the other.
