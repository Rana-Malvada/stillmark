SET LOCAL lock_timeout='5s';
-- The member description allowance was withdrawn. Restore the single five-argument
-- claim exactly as it was before 202611220200 and remove that migration's objects.
CREATE OR REPLACE FUNCTION claim_photo_ai(p_claim uuid,p_fleet int,p_tenant int,p_hour int,p_tenant_hour int)
RETURNS TABLE(photo_id int,display_stage_path text,file_hash text,ai_attempts int)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE current_hour timestamptz := date_trunc('hour',now(),'UTC'); selected_id int; owner_name text; budget public.photo_ai_admission%ROWTYPE;
BEGIN
 IF p_claim IS NULL OR p_fleet IS NULL OR p_tenant IS NULL OR p_hour IS NULL OR p_tenant_hour IS NULL
 OR p_fleet NOT BETWEEN 1 AND 1000 OR p_tenant NOT BETWEEN 1 AND p_fleet
 OR p_hour NOT BETWEEN 1 AND 1000000 OR p_tenant_hour NOT BETWEEN 1 AND p_hour THEN
   RAISE EXCEPTION 'Invalid photo AI admission limits' USING ERRCODE='22023';
 END IF;
 SELECT * INTO budget FROM public.photo_ai_admission WHERE id=1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Photo AI admission is unavailable'; END IF;
 IF budget.window_start=current_hour AND budget.attempts>=p_hour THEN RETURN; END IF;
 IF (SELECT count(*) FROM public.photos p WHERE p.ai_claim IS NOT NULL AND p.ai_lease_until>now() AND p.ai_description IS NULL)>=p_fleet THEN RETURN; END IF;
 WITH active_tenants AS MATERIALIZED (
 SELECT ae.owner_username,count(*) AS active_count FROM public.photos active
 JOIN public.events ae USING(event_id) WHERE active.ai_claim IS NOT NULL
 AND active.ai_lease_until>now() AND active.ai_description IS NULL GROUP BY ae.owner_username
 )
 SELECT p.photo_id,e.owner_username INTO selected_id,owner_name
 FROM public.photos p JOIN public.events e USING(event_id)
 LEFT JOIN public.photo_ai_tenant_admission t ON t.owner_username=e.owner_username
 LEFT JOIN active_tenants active_tenant ON active_tenant.owner_username=e.owner_username
 WHERE p.ai_description IS NULL AND p.ai_attempts<3 AND p.ai_next_attempt_at<=now()
 AND (p.ai_lease_until IS NULL OR p.ai_lease_until<now())
 AND p.ingest_status='READY' AND p.display_stage_path IS NOT NULL AND p.media_type='photo'
 AND (t.owner_username IS NULL OR t.window_start<>current_hour OR t.attempts<p_tenant_hour)
 AND COALESCE(active_tenant.active_count,0)<p_tenant
 ORDER BY t.claim_sequence ASC NULLS FIRST,p.photo_id
 LIMIT 1 FOR UPDATE OF p SKIP LOCKED;
 IF selected_id IS NULL THEN RETURN; END IF;
 UPDATE public.photo_ai_admission SET window_start=current_hour,claim_sequence=claim_sequence+1,
   attempts=CASE WHEN window_start=current_hour THEN attempts+1 ELSE 1 END WHERE id=1;
 INSERT INTO public.photo_ai_tenant_admission(owner_username,last_claimed_at,claim_sequence,window_start,attempts)
 VALUES(owner_name,clock_timestamp(),budget.claim_sequence+1,current_hour,1)
 ON CONFLICT(owner_username) DO UPDATE SET last_claimed_at=EXCLUDED.last_claimed_at,claim_sequence=EXCLUDED.claim_sequence,
 window_start=EXCLUDED.window_start,
 attempts=CASE WHEN photo_ai_tenant_admission.window_start=EXCLUDED.window_start THEN photo_ai_tenant_admission.attempts+1 ELSE 1 END;
 RETURN QUERY UPDATE public.photos p SET ai_claim=p_claim,ai_lease_until=now()+interval '15 minutes',ai_attempts=p.ai_attempts+1
 WHERE p.photo_id=selected_id RETURNING p.photo_id,p.display_stage_path::text,p.file_hash::text,p.ai_attempts;
END $$;
DROP FUNCTION claim_photo_ai(uuid,int,int,int,int,int);
DROP FUNCTION photo_security.photo_ai_unlimited_owners();
