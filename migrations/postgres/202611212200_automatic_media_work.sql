SET LOCAL lock_timeout='5s';
CREATE SEQUENCE public.automatic_work_revision;
CREATE TABLE public.automatic_work_signals(
 kind text NOT NULL CHECK(kind IN ('faces','playback','ocr','search')),
 source_type text NOT NULL DEFAULT 'photo',
 source_id bigint NOT NULL,
 revision bigint NOT NULL DEFAULT nextval('public.automatic_work_revision'),
 PRIMARY KEY(kind,source_type,source_id)
);
CREATE INDEX automatic_work_signal_order ON public.automatic_work_signals(kind,revision);
CREATE TABLE public.automatic_work_state(
 kind text PRIMARY KEY CHECK(kind='search'),
 run_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
 started_at timestamptz NOT NULL DEFAULT now(),
 deadline timestamptz NOT NULL,
 finished_at timestamptz,
 error text
);
ALTER TABLE public.automatic_work_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automatic_work_signals FORCE ROW LEVEL SECURITY;
ALTER TABLE public.automatic_work_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automatic_work_state FORCE ROW LEVEL SECURITY;
CREATE POLICY automatic_signal_service ON public.automatic_work_signals TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY automatic_state_service ON public.automatic_work_state TO personal_photos_maintenance USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.automatic_work_signals,public.automatic_work_state TO personal_photos_maintenance;
GRANT USAGE ON SEQUENCE public.automatic_work_revision TO personal_photos_maintenance;
CREATE POLICY automatic_signal_admin_read ON public.automatic_work_signals FOR SELECT TO personal_photos_app
 USING(kind IN ('faces','playback') AND photo_security.flag('main_admin'));
CREATE POLICY automatic_signal_admin_ack ON public.automatic_work_signals FOR DELETE TO personal_photos_app
 USING(kind IN ('faces','playback') AND photo_security.flag('main_admin'));
GRANT SELECT,DELETE ON public.automatic_work_signals TO personal_photos_app;
ALTER TABLE public.search_batch_runs ADD COLUMN automatic_photo_ids int[], ADD COLUMN idle_since timestamptz;

-- Trigger-owned signals have no client privileges. Do not seed old backlogs:
-- installation must not restart previously cancelled or failed work.
CREATE FUNCTION photo_security.signal_automatic_media_work() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE work_kind text := TG_ARGV[0]; source_kind text := 'photo'; item_id bigint;
BEGIN
 IF work_kind='search' THEN
  IF TG_OP='UPDATE' AND NEW.revision IS NOT DISTINCT FROM OLD.revision THEN RETURN NULL; END IF;
  item_id:=NEW.id; source_kind:=NEW.kind;
 ELSIF work_kind='playback' THEN
  IF NEW.status<>'queued' THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND NEW.original_path IS NOT DISTINCT FROM OLD.original_path THEN RETURN NULL; END IF;
  item_id:=NEW.photo_id;
 ELSE
  IF NEW.status<>'queued' THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND NEW.source_path IS NOT DISTINCT FROM OLD.source_path THEN RETURN NULL; END IF;
  item_id:=NEW.photo_id;
 END IF;
 INSERT INTO public.automatic_work_signals(kind,source_type,source_id)
 VALUES(work_kind,source_kind,item_id)
 ON CONFLICT(kind,source_type,source_id) DO UPDATE SET revision=nextval('public.automatic_work_revision');
 -- Empty payloads coalesce within the committing upload transaction. Reuse the
 -- existing listener; search publication deliberately keeps its slower cadence.
 IF work_kind IN ('faces','playback','ocr') THEN
  PERFORM pg_notify('stillmark_photo_ai_ready','');
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.signal_automatic_media_work() FROM PUBLIC;
CREATE TRIGGER automatic_faces AFTER INSERT OR UPDATE ON public.face_scan_queue
 FOR EACH ROW EXECUTE FUNCTION photo_security.signal_automatic_media_work('faces');
CREATE TRIGGER automatic_playback AFTER INSERT OR UPDATE ON public.video_playback
 FOR EACH ROW EXECUTE FUNCTION photo_security.signal_automatic_media_work('playback');
CREATE TRIGGER automatic_ocr AFTER INSERT OR UPDATE ON public.search_enrichment
 FOR EACH ROW EXECUTE FUNCTION photo_security.signal_automatic_media_work('ocr');
CREATE TRIGGER automatic_search AFTER INSERT OR UPDATE ON public.search_queue
 FOR EACH ROW EXECUTE FUNCTION photo_security.signal_automatic_media_work('search');
