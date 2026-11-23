SET LOCAL lock_timeout='5s';
CREATE TABLE photo_inference_receipts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 photo_id int REFERENCES photos(photo_id) ON DELETE SET NULL,
 retired boolean NOT NULL DEFAULT false,
 prompt_version text NOT NULL, source_path text NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','dispatched','received')),
 cost_id uuid, model text, result text, usage jsonb, provider_request_id text,
 ledger_done boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photo_inference_ledger_pending ON photo_inference_receipts(updated_at) WHERE state='received' AND NOT ledger_done;
ALTER TABLE photo_inference_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_inference_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY maintain ON photo_inference_receipts TO personal_photos_maintenance USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON photo_inference_receipts TO personal_photos_maintenance;

CREATE UNIQUE INDEX photo_inference_active ON photo_inference_receipts(photo_id,prompt_version,source_path) WHERE NOT retired AND photo_id IS NOT NULL;
CREATE FUNCTION photo_security.retry_photo_inference(p_id int) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT photo_security.flag('main_admin') THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501'; END IF;
 UPDATE public.photos SET ai_attempts=0,ai_error=NULL,ai_next_attempt_at=now()
 WHERE photo_id=p_id AND ai_description IS NULL AND ai_attempts>=3 AND (ai_lease_until IS NULL OR ai_lease_until<now());
 IF FOUND THEN
   UPDATE public.photo_inference_receipts SET retired=true WHERE photo_id=p_id AND NOT retired;
 END IF;
END $$;
REVOKE ALL ON FUNCTION photo_security.retry_photo_inference(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.retry_photo_inference(int) TO personal_photos_app;
