# Search interpretation cost attribution

Allows search_ai in the existing cost-work category constraint. Existing values, owners, grants and RLS remain unchanged. Both the old and new runtime are compatible. Apply through the migration runner before deploying the new runtime.

The interpreter records provider request IDs, reported tokens and elapsed milliseconds in the existing REST ledger, without saving prompts. Credits remain unknown until Snowflake billing reconciliation. Verify the category constraint and existing cost attribution tests. Rollback the application without removing the category or recorded usage.
