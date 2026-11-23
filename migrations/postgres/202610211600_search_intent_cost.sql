ALTER TABLE public.cost_work DROP CONSTRAINT cost_work_category_check;
ALTER TABLE public.cost_work ADD CONSTRAINT cost_work_category_check
 CHECK(category IN ('ai','photo_ai','video_ai','search_indexing','warehouse','search_ai'));
