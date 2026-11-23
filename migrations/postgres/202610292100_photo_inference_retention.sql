SET LOCAL lock_timeout='5s';
CREATE INDEX photo_inference_disposable ON photo_inference_receipts(updated_at,id)
WHERE state='received' AND ledger_done AND (retired OR photo_id IS NULL);

CREATE FUNCTION photo_security.prune_photo_inference_receipts(p_days int) RETURNS int
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE removed int;
BEGIN
  IF p_days IS NULL OR p_days<30 OR p_days>3650 THEN
    RAISE EXCEPTION 'Invalid receipt retention' USING ERRCODE='22023';
  END IF;
  WITH expired AS (
    SELECT id FROM public.photo_inference_receipts
    WHERE state='received' AND ledger_done AND (retired OR photo_id IS NULL)
      AND updated_at < now() - (p_days * interval '1 day')
    ORDER BY updated_at,id LIMIT 100 FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.photo_inference_receipts r USING expired x WHERE r.id=x.id RETURNING r.id
  ) SELECT count(*)::int INTO removed FROM deleted;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION photo_security.prune_photo_inference_receipts(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.prune_photo_inference_receipts(int) TO personal_photos_maintenance;
