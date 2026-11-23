-- Additive migration: old in-flight database chunks remain readable.
BEGIN;
ALTER TABLE upload_chunks ALTER COLUMN data DROP NOT NULL;
ALTER TABLE upload_chunks ADD COLUMN IF NOT EXISTS stage_path TEXT;
ALTER TABLE upload_chunks ADD COLUMN IF NOT EXISTS byte_size INTEGER;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='upload_chunks_storage') THEN
 ALTER TABLE upload_chunks ADD CONSTRAINT upload_chunks_storage CHECK (
 (data IS NOT NULL AND stage_path IS NULL) OR
 (data IS NULL AND stage_path IS NOT NULL AND byte_size BETWEEN 1 AND 8388608));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS upload_chunks_stage_path ON upload_chunks(stage_path) WHERE stage_path IS NOT NULL;
COMMIT;
