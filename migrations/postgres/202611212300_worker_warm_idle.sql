SET LOCAL lock_timeout='5s';
ALTER TABLE public.face_scan_runs ADD COLUMN idle_since timestamptz,
 ADD COLUMN accepting_work boolean NOT NULL DEFAULT true;
ALTER TABLE public.video_preparation_runs ADD COLUMN idle_since timestamptz,
 ADD COLUMN accepting_work boolean NOT NULL DEFAULT true,
 ADD COLUMN cycle_deadline timestamptz NOT NULL DEFAULT (now()+interval '3 hours'),
 ADD COLUMN continued_from uuid UNIQUE REFERENCES public.video_preparation_runs(id);

-- Admission locks this same run row before appending uploaded media. Closing an
-- idle worker and appending work therefore cannot both win. Existing hard runtime
-- and claim limits remain separate, unchanged safety bounds.
CREATE FUNCTION photo_security.worker_idle(kind text, run uuid) RETURNS text
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE runs text; queue text; run_column text; current_status text; idle timestamptz;
 accepting boolean; pending boolean;
BEGIN
 IF kind='faces' THEN runs:='face_scan_runs'; queue:='face_scan_queue'; run_column:='run_id';
 ELSIF kind='playback' THEN runs:='video_preparation_runs'; queue:='video_playback'; run_column:='preparation_run_id';
 ELSE RAISE EXCEPTION 'Invalid worker kind'; END IF;
 EXECUTE format('SELECT status,idle_since,accepting_work FROM public.%I WHERE id=$1 FOR UPDATE',runs)
 INTO current_status,idle,accepting USING run;
 IF current_status IS DISTINCT FROM 'running' OR NOT accepting THEN RETURN 'closed'; END IF;
 EXECUTE format('SELECT EXISTS(SELECT FROM public.%I WHERE %I=$1 AND status IN (''queued'',''running''))',queue,run_column)
 INTO pending USING run;
 IF pending THEN
  EXECUTE format('UPDATE public.%I SET idle_since=NULL WHERE id=$1 AND idle_since IS NOT NULL',runs) USING run;
  RETURN 'work';
 END IF;
 IF idle IS NULL THEN
  EXECUTE format('UPDATE public.%I SET idle_since=now() WHERE id=$1',runs) USING run;
  RETURN 'idle';
 END IF;
 IF idle>now()-interval '15 minutes' THEN RETURN 'idle'; END IF;
 EXECUTE format('UPDATE public.%I SET accepting_work=false WHERE id=$1',runs) USING run;
 RETURN 'closed';
END $$;
GRANT USAGE ON SCHEMA photo_security TO personal_photos_face_worker,personal_photos_video_worker;
REVOKE ALL ON FUNCTION photo_security.worker_idle(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.worker_idle(text,uuid)
 TO personal_photos_face_worker,personal_photos_video_worker,personal_photos_maintenance;
