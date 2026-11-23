# PostgreSQL monitoring retention

This policy limits raw pgInsights history without changing application data.
It is database maintenance, separate from upload, AI and media workers. Use an
explicitly authorized database administrator with verified TLS. Keep credentials,
preflight snapshots and execution results outside Git.

## Retention policy

- Raw monitoring samples: seven days at each purge invocation.
- Hourly metrics and query history: 180 days.
- Daily metrics: 360 days; properties: 60 days.
- Schedule: `17 8 * * *`, with `cron.timezone` verified as UTC (08:17 UTC;
  03:17 EST or 04:17 EDT).
- A daily seven-day cutoff can retain almost eight days immediately before the
  next scheduled run. This is not continuous expiration at exactly seven days.

Do not apply this policy to photos, wine data, application events or job queues.
Collection and rollup remain enabled. Only the provider's `purge` collection is
disabled while the replacement named job owns purging; its recorded interval is
preserved. Query history and aggregated metrics retain their separate policies.

## Inspect before installation or changes

The supported first choice is the Snowflake PostgreSQL instance setting
`postgres:insights.retention_raw='7d'`. If the installed control plane rejects
that setting, use the supported `insights.pgi_snapshot_purge` procedure and
`pg_cron` extension. Do not use `ALTER SYSTEM` or edit provider configuration files.
Do not enable both mechanisms for the same maintenance.

Before making changes:

1. Inspect `pg_settings` for `insights.retention*`, the installed
   `insights.pgi_snapshot_purge` signature and procedure body, and
   `insights.pgi_collection`. Confirm the four argument meanings match this guide.
2. Save the provider purge row, every collection's enabled/interval settings and
   existing `cron.job` definitions. Refuse to replace an unrelated job.
3. Check physical data-volume free space, WAL usage, active uploads and blockers.
   Deletion generates WAL and dead tuples before vacuum can reuse pages.
   `pg_database_size` alone does not establish physical free space.
4. If a large backlog exists, catch up in independently committed one-day cutoff
   increments. Set `lock_timeout='1s'` and `statement_timeout='30s'` for each step.
   Use the same purge procedure with temporary raw retention equal to the time
   since the next cutoff, never a cutoff newer than seven days ago. Preserve the
   other three retention arguments. Check the actual oldest sample after each
   commit; a canceled step rolls back and is not progress.

Let competing autovacuum or maintenance finish after lock conflicts. Do not cancel
it or increase the lock timeout to force the purge through.

## Scheduled command

Use the unique job name `stillmark-insights-raw-7d`. Install through `cron.schedule`
only after preflight, in one transaction that verifies the saved provider purge
row, disables only that row and creates the new job. Create the extension if
needed through an authorized administrator. Fail if the named job already exists;
inspect and update that exact job deliberately instead of creating a duplicate.

The job command is one `DO` statement:

```sql
DO $retention$
DECLARE attempt integer;
BEGIN
  PERFORM set_config('transaction_timeout', '300s', true);
  PERFORM set_config('lock_timeout', '1s', true);
  IF NOT pg_try_advisory_xact_lock(7312026, 7) THEN
    RAISE EXCEPTION 'Monitoring retention is already running';
  END IF;
  IF EXISTS (
    SELECT 1 FROM insights.pgi_collection
    WHERE col_name = 'purge' AND enabled
  ) THEN
    RAISE EXCEPTION 'Provider purge enabled; refuse overlapping maintenance';
  END IF;
  FOR attempt IN 1..3 LOOP
    BEGIN
      CALL insights.pgi_snapshot_purge(
        interval '7 days', interval '180 days',
        interval '360 days', interval '60 days'
      );
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt = 3 THEN RAISE; END IF;
      PERFORM pg_sleep(5);
    END;
  END LOOP;
END $retention$;
```

Confirm the installed PostgreSQL supports `transaction_timeout` and starts its
transaction timer when set inside this command. The whole transaction is bounded
at 300 seconds; a timeout terminates this maintenance session and rolls back the
run. Lock retries are limited to three attempts with five-second waits. `pg_cron`
serializes a given job; use the same advisory lock for manual catch-up so it cannot
race the scheduled job.

## Verification and recovery

Read `cron.job` and verify exactly one active matching job, command, schedule and
UTC timezone. For execution proof, inspect `cron.job_run_details` and require a
non-null `end_time`, final `status='succeeded'` and `return_message='DO'`. Leading
`SET` statements can produce an intermediate success; they do not prove the purge
finished. Do not treat a started run or an unchanged old timestamp as completion.

Check the oldest raw snapshot with `ORDER BY snapshot_dt LIMIT 1` and compare it
to the completed invocation's seven-day cutoff. Avoid an unbounded full-table
count. Compare collection settings with preflight: only `purge.enabled` should
change. To verify scheduling immediately, temporarily change the same job to run
every minute, restore its daily schedule as soon as it starts, and wait for the
final result. Restore the daily schedule in every error/exit path; never create a
second validation job.

Inspect failed run details and actual oldest samples. If a backlog develops,
resume small committed cutoff steps after checking free space and active uploads.
Do not leave an indefinitely failing backlog purge or silently increase its
runtime budget. Monitor autovacuum and dead-tuple estimates. Normal deletion and
vacuum make space reusable but do not guarantee a smaller allocated volume.
Do not run `VACUUM FULL` during application traffic.

## Rollback

Stop scheduling the exact named job with `cron.unschedule(jobid)` and restore the
provider purge `enabled` and `collect_interval` values captured before installation,
in one bounded transaction. First wait until no execution is active;
unscheduling can cancel an active run. Do not remove unrelated jobs or drop
`pg_cron`. Verify provider collection and rollup settings after rollback.

Use recorded original values rather than assuming the provider's default interval.
Previously purged raw samples cannot be recovered by reverting the schedule;
aggregated metrics and query history follow their own retained intervals. With the
procedure-based approach, the global raw-retention setting remains unchanged.

See [production operations](PRODUCTION.md) for access and incident handling.
