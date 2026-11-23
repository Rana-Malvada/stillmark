# Permission function row estimates

The identity functions return at most one row, keyed by a unique account UUID or linked subject. Declare `ROWS 1` so PostgreSQL does not cost their lateral join as a million-row result and trigger JIT compilation for a tiny authorization lookup.

This migration changes optimizer metadata only. Permissions, replay protection, revocation, row security, and function bodies are unchanged. Apply after the authority migration. Verify `prorows=1` for all three functions. Reverting the estimates to 1000 restores the performance problem and is not needed for legacy-authority rollback.
