SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Reserve cleanup before crop files are written, independently of publication.
-- This narrow entry point does not expose arbitrary storage paths or grant table
-- access. The existing publication/cleanup fence and live-reference checks apply.
CREATE FUNCTION face_worker.reserve_crops(photo integer, token uuid, paths text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF paths IS NULL OR cardinality(paths)>5000 OR coalesce(array_ndims(paths),1)<>1
   OR EXISTS(SELECT FROM unnest(paths) p WHERE p IS NULL OR
     p !~ '^faces/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$') THEN
   RAISE EXCEPTION 'invalid face crop paths' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM public.face_scan_queue q
 WHERE q.photo_id=photo AND q.claim_token=token AND q.status='running' AND q.lease_until>now()
 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'stale face claim' USING ERRCODE='40001'; END IF;
 PERFORM photo_security.assert_storage_publishable(paths);
 INSERT INTO public.stage_cleanup(path,next_attempt)
 SELECT DISTINCT p,now()+interval '24 hours' FROM unnest(paths) p
 ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION face_worker.reserve_crops(integer,uuid,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION face_worker.reserve_crops(integer,uuid,text[]) TO personal_photos_face_worker;
