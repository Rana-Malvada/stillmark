# Indexed media lookups and album ordering

Additive indexes; the previous app remains compatible. Originals, rendition records,
RLS policies and grants are unchanged. The existing path indexes serve independent
UNION ALL branches; playback JSON uses containment with a matching GIN index.
The compound date index matches the ready-photo cursor ordering in both directions.

Apply with the checked migration runner, including its backup restore drill.
Lock acquisition is bounded to five seconds and statements to one minute. Retry a
failed migration at a quieter time; do not disable the bounds. At the current catalog
size the index build is small; for a substantially larger installation schedule an
online index migration through an explicitly reviewed nontransactional procedure.

Verify EXPLAIN (ANALYZE, BUFFERS) as the app role for thumbnail, original and both
video rendition paths, and date pagination. Verify private, shared, removed, stale
rendition and revoked access cases. Rollback the app without dropping these indexes.
