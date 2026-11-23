BEGIN;
ALTER TABLE cost_work DROP CONSTRAINT IF EXISTS cost_work_category_check;
ALTER TABLE cost_work ADD CONSTRAINT cost_work_category_check CHECK(category IN ('ai','photo_ai','video_ai','search_indexing','warehouse'));
COMMIT;
