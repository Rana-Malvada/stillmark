# Durable search batch completion

Add nullable completion markers. Prevents polling Snowflake after a job is settled
and records the single authorized rerank continuation. Old runtimes ignore these
columns. No compute starts from this migration. Verify completion is idempotent and
cancelled runs never start a continuation.
