-- Additive limit increase; existing uploads and completed results are retained.
BEGIN;
ALTER TABLE upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_total_chunks_check;
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_total_chunks_check CHECK(total_chunks BETWEEN 1 AND 75);
ALTER TABLE upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_bytes_check;
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_bytes_check CHECK(bytes BETWEEN 0 AND 629145600);
ALTER TABLE upload_chunks DROP CONSTRAINT IF EXISTS upload_chunks_chunk_index_check;
ALTER TABLE upload_chunks ADD CONSTRAINT upload_chunks_chunk_index_check CHECK(chunk_index BETWEEN 0 AND 74);
COMMIT;
