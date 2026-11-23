-- Does not enqueue, clear or reprocess any descriptions.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS ai_prompt_version TEXT;
UPDATE photos SET ai_prompt_version='legacy'
 WHERE ai_description IS NOT NULL AND ai_prompt_version IS NULL;
COMMENT ON COLUMN photos.ai_prompt_version IS
 'Description provenance: legacy or v2-factual. Duplicate reuse preserves source version.';
