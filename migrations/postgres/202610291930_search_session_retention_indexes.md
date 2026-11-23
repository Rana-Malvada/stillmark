# Search session retention indexes

Compatibility: additive indexes only. Old and new application versions can use the same search-session table. Index creation uses the migration transaction and a five-second lock timeout; a timeout must abort rather than silently ignore the index. No session rows are changed by the migration.

Verification: `tests/search-session-maintenance.test.ts` checks bounded pruning and retention of the newest fifty viewer sessions. The People/search suite checks cursor ownership and revocation. Run EXPLAIN with representative cardinality after installation before claiming a production latency improvement.

Rollback: leave indexes installed when rolling back application code. If an index must be removed, drop only `search_session_expiration` and `search_session_viewer_recency` after reviewing concurrent activity; no data restoration is needed. Follow the normal backup/restore gate before applying migrations.
