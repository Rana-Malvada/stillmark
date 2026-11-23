SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='personal_photos_face_worker') THEN
 CREATE ROLE personal_photos_face_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS ADMIN snowflake_admin;
 END IF;
END $$;
ALTER ROLE personal_photos_face_worker SET search_path=public,pg_catalog;
ALTER ROLE personal_photos_face_worker SET statement_timeout='30s';
GRANT CONNECT ON DATABASE postgres TO personal_photos_face_worker;
GRANT USAGE ON SCHEMA public TO personal_photos_face_worker;

-- Recognition is opt-in per album owner. Names are private unless explicitly shared.
CREATE TABLE public.face_settings (
 owner_username text PRIMARY KEY,
 enabled boolean NOT NULL DEFAULT false,
 share_names boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.face_people (
 person_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_username text NOT NULL,
 name text CHECK (name IS NULL OR (name=btrim(name) AND length(name) BETWEEN 1 AND 80)),
 cover_face_id bigint,
 hidden boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(person_id,owner_username)
);
CREATE INDEX face_people_owner ON public.face_people(owner_username);
CREATE INDEX face_people_name_trgm ON public.face_people USING gin(lower(name) gin_trgm_ops) WHERE name IS NOT NULL;
-- Faces are keyed by photo_id without a cascading foreign key: Trash removes and
-- restores the photos row under the same id, and face data must survive that.
CREATE TABLE public.faces (
 face_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 photo_id integer NOT NULL,
 owner_username text NOT NULL,
 source text NOT NULL DEFAULT 'detected' CHECK (source IN ('detected','manual')),
 source_path text,
 model_version text,
 face_index smallint CHECK (face_index>=0),
 box_x real CHECK (box_x BETWEEN 0 AND 1),
 box_y real CHECK (box_y BETWEEN 0 AND 1),
 box_w real CHECK (box_w>0 AND box_w<=1),
 box_h real CHECK (box_h>0 AND box_h<=1),
 detection_score real,
 quality real,
 quality_ok boolean NOT NULL DEFAULT false,
 embedding vector,
 crop_path text,
 ignored boolean NOT NULL DEFAULT false,
 created_by text,
 created_at timestamptz NOT NULL DEFAULT now(),
 -- A box is all-or-nothing and stays inside the image.
 CHECK ((box_x IS NULL)=(box_y IS NULL) AND (box_x IS NULL)=(box_w IS NULL) AND (box_x IS NULL)=(box_h IS NULL)),
 CHECK (box_x IS NULL OR (box_x+box_w<=1.0001 AND box_y+box_h<=1.0001)),
 -- Detected faces carry the full scan record. Manual tags (a drawn box or a
 -- name-only tag for a face the scanner missed) never carry an embedding, so
 -- they are never used as matching references.
 CHECK (source<>'detected' OR (source_path IS NOT NULL AND model_version IS NOT NULL AND face_index IS NOT NULL
  AND box_x IS NOT NULL AND detection_score IS NOT NULL AND quality IS NOT NULL AND embedding IS NOT NULL)),
 CHECK (source<>'manual' OR (embedding IS NULL AND model_version IS NULL AND face_index IS NULL AND NOT quality_ok
  AND created_by IS NOT NULL)),
 UNIQUE(photo_id,model_version,face_index),
 UNIQUE(face_id,owner_username)
);
CREATE INDEX faces_owner_model ON public.faces(owner_username,model_version);
-- Supports the Unknown faces list: settled-quality faces with no assignment.
CREATE INDEX faces_owner_photo ON public.faces(owner_username,photo_id);
ALTER TABLE public.face_people ADD FOREIGN KEY(cover_face_id) REFERENCES public.faces(face_id) ON DELETE SET NULL;
-- Composite keys make a cross-owner assignment impossible.
CREATE TABLE public.face_assignments (
 face_id bigint PRIMARY KEY,
 person_id uuid NOT NULL,
 owner_username text NOT NULL,
 status text NOT NULL CHECK (status IN ('suggested','auto','confirmed')),
 score real,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(face_id,owner_username) REFERENCES public.faces(face_id,owner_username) ON DELETE CASCADE,
 FOREIGN KEY(person_id,owner_username) REFERENCES public.face_people(person_id,owner_username) ON DELETE CASCADE
);
CREATE INDEX face_assignments_person ON public.face_assignments(person_id,status);
CREATE TABLE public.face_rejections (
 face_id bigint NOT NULL,
 person_id uuid NOT NULL,
 owner_username text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(face_id,person_id),
 FOREIGN KEY(face_id,owner_username) REFERENCES public.faces(face_id,owner_username) ON DELETE CASCADE,
 FOREIGN KEY(person_id,owner_username) REFERENCES public.face_people(person_id,owner_username) ON DELETE CASCADE
);
CREATE TABLE public.face_corrections (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 owner_username text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('rename','confirm','reject','assign','merge','split','ignore','unignore','hide','unhide','cover')),
 summary text NOT NULL,
 before_state jsonb NOT NULL,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 undone_at timestamptz
);
CREATE INDEX face_corrections_owner ON public.face_corrections(owner_username,created_at DESC);
CREATE TABLE public.face_scan_runs (
 id uuid PRIMARY KEY,
 requested_by text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('pilot','backfill','incremental')),
 status text NOT NULL CHECK (status IN ('starting','running','completed','cancelled','attention')),
 photo_limit integer NOT NULL CHECK (photo_limit BETWEEN 1 AND 100000),
 total integer NOT NULL DEFAULT 0,
 processed integer NOT NULL DEFAULT 0,
 failed integer NOT NULL DEFAULT 0,
 faces_found integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 finished_at timestamptz,
 heartbeat_at timestamptz NOT NULL DEFAULT now(),
 error text
);
CREATE UNIQUE INDEX face_scan_runs_one_active ON public.face_scan_runs((true)) WHERE status IN ('starting','running');
CREATE TABLE public.face_scan_queue (
 photo_id integer PRIMARY KEY,
 owner_username text NOT NULL,
 source_path text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
 attempts integer NOT NULL DEFAULT 0,
 claim_token uuid,
 lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 run_id uuid REFERENCES public.face_scan_runs(id) ON DELETE SET NULL,
 model_version text,
 requested_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 error text
);
CREATE INDEX face_scan_queue_due ON public.face_scan_queue(next_attempt_at,requested_at) WHERE status='queued';
CREATE INDEX face_scan_queue_run ON public.face_scan_queue(run_id,status);

-- Corrections take priority over scans: the worker cannot alter or remove a
-- confirmed assignment, and nobody can assign a face to a rejected person.
CREATE FUNCTION photo_security.guard_face_assignment() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 BEGIN
 IF TG_OP<>'INSERT' AND OLD.status='confirmed' AND current_user='personal_photos_face_worker' THEN
  RAISE EXCEPTION 'confirmed face assignments are user-owned' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF EXISTS(SELECT FROM public.face_rejections r WHERE r.face_id=NEW.face_id AND r.person_id=NEW.person_id) THEN
  RAISE EXCEPTION 'face was rejected for this person' USING ERRCODE='23514';
 END IF;
 NEW.updated_at:=now();
 RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION photo_security.guard_face_assignment() FROM PUBLIC;
CREATE TRIGGER guard_face_assignment BEFORE INSERT OR UPDATE OR DELETE ON public.face_assignments
 FOR EACH ROW EXECUTE FUNCTION photo_security.guard_face_assignment();
-- Cascaded deletes run as the table owner, so the face row itself is guarded too.
-- Manual tags are always user-owned.
CREATE FUNCTION photo_security.guard_confirmed_face() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 BEGIN
 IF current_user='personal_photos_face_worker' AND (OLD.source='manual'
 OR EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=OLD.face_id AND a.status='confirmed')) THEN
  RAISE EXCEPTION 'confirmed face assignments are user-owned' USING ERRCODE='42501';
 END IF;
 RETURN OLD;
 END $$;
REVOKE ALL ON FUNCTION photo_security.guard_confirmed_face() FROM PUBLIC;
CREATE TRIGGER guard_confirmed_face BEFORE DELETE ON public.faces
 FOR EACH ROW EXECUTE FUNCTION photo_security.guard_confirmed_face();

-- Queue still images whose owner opted in. Never scans the library per tick.
CREATE FUNCTION photo_security.enqueue_face_scan() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE owner text;
 BEGIN
 IF NEW.media_type='photo' AND NEW.ingest_status='READY' AND NEW.original_stage_path IS NOT NULL THEN
  SELECT e.owner_username INTO owner FROM public.events e JOIN public.face_settings s ON s.owner_username=e.owner_username AND s.enabled
   WHERE e.event_id=NEW.event_id;
  IF owner IS NOT NULL THEN
   INSERT INTO public.face_scan_queue(photo_id,owner_username,source_path) VALUES(NEW.photo_id,owner,NEW.original_stage_path)
   ON CONFLICT(photo_id) DO UPDATE SET owner_username=EXCLUDED.owner_username,source_path=EXCLUDED.source_path,status='queued',
    attempts=0,claim_token=NULL,lease_until=NULL,next_attempt_at=now(),requested_at=now(),completed_at=NULL,error=NULL,run_id=NULL
   WHERE face_scan_queue.source_path IS DISTINCT FROM EXCLUDED.source_path;
  END IF;
 END IF;
 RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION photo_security.enqueue_face_scan() FROM PUBLIC,personal_photos_app;
CREATE TRIGGER enqueue_face_scan AFTER INSERT OR UPDATE OF original_stage_path,ingest_status ON public.photos
 FOR EACH ROW EXECUTE FUNCTION photo_security.enqueue_face_scan();

-- Remove face data once the last live or trashed reference to a photo is gone.
CREATE FUNCTION photo_security.retire_faces() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
 IF NOT EXISTS(SELECT FROM public.photos WHERE photo_id=OLD.photo_id)
 AND NOT EXISTS(SELECT FROM public.photo_trash WHERE photo_id=OLD.photo_id) THEN
  WITH removed AS (DELETE FROM public.faces WHERE photo_id=OLD.photo_id RETURNING crop_path)
  INSERT INTO public.stage_cleanup(path,next_attempt) SELECT crop_path,now() FROM removed WHERE crop_path IS NOT NULL ON CONFLICT DO NOTHING;
  DELETE FROM public.face_scan_queue WHERE photo_id=OLD.photo_id;
 END IF;
 RETURN OLD;
 END $$;
REVOKE ALL ON FUNCTION photo_security.retire_faces() FROM PUBLIC,personal_photos_app;
CREATE TRIGGER retire_faces AFTER DELETE ON public.photos FOR EACH ROW EXECUTE FUNCTION photo_security.retire_faces();
CREATE TRIGGER retire_faces AFTER DELETE ON public.photo_trash FOR EACH ROW EXECUTE FUNCTION photo_security.retire_faces();

-- Owner-scope helpers. A shared viewer sees a name only when the owner shares
-- names and the face is a settled match on a photo the viewer can already read.
CREATE FUNCTION photo_security.owns_people(who text) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public AS
 $$ SELECT photo_security.username() IS NOT NULL AND (who=photo_security.username() OR photo_security.flag('main_admin')) $$;
CREATE FUNCTION photo_security.edits_people(who text) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public AS
 $$ SELECT photo_security.flag('can_write') AND photo_security.owns_people(who) $$;
CREATE FUNCTION photo_security.photo_owner(id integer) RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS
 $$ SELECT e.owner_username FROM public.photos p JOIN public.events e USING(event_id) WHERE p.photo_id=id $$;
CREATE FUNCTION photo_security.shared_face(id bigint) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS
 $$ SELECT photo_security.username() IS NOT NULL AND EXISTS(
  SELECT FROM public.faces f JOIN public.face_assignments a USING(face_id)
  JOIN public.face_settings s ON s.owner_username=f.owner_username AND s.enabled AND s.share_names
  JOIN public.face_people p ON p.person_id=a.person_id AND NOT p.hidden AND p.name IS NOT NULL
  WHERE f.face_id=id AND NOT f.ignored AND a.status IN ('auto','confirmed') AND photo_security.read_photo(f.photo_id)) $$;
CREATE FUNCTION photo_security.shared_person(id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS
 $$ SELECT EXISTS(SELECT FROM public.face_assignments a WHERE a.person_id=id AND photo_security.shared_face(a.face_id)) $$;
REVOKE ALL ON FUNCTION photo_security.owns_people(text),photo_security.edits_people(text),photo_security.photo_owner(integer),
 photo_security.shared_face(bigint),photo_security.shared_person(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.owns_people(text),photo_security.edits_people(text),photo_security.photo_owner(integer),
 photo_security.shared_face(bigint),photo_security.shared_person(uuid) TO personal_photos_app;

ALTER TABLE public.face_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.face_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.faces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.face_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.face_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.face_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.face_scan_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.face_scan_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.face_settings,public.face_people,public.faces,public.face_assignments,public.face_rejections,
 public.face_corrections,public.face_scan_runs,public.face_scan_queue FROM PUBLIC,personal_photos_app;

-- Web application. Embeddings are never readable by the app role.
GRANT SELECT,INSERT,UPDATE ON public.face_settings TO personal_photos_app;
CREATE POLICY app_read ON public.face_settings FOR SELECT TO personal_photos_app USING(photo_security.owns_people(owner_username));
CREATE POLICY app_insert ON public.face_settings FOR INSERT TO personal_photos_app WITH CHECK(photo_security.edits_people(owner_username));
CREATE POLICY app_update ON public.face_settings FOR UPDATE TO personal_photos_app USING(photo_security.edits_people(owner_username)) WITH CHECK(photo_security.edits_people(owner_username));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.face_people TO personal_photos_app;
CREATE POLICY app_read ON public.face_people FOR SELECT TO personal_photos_app USING(photo_security.owns_people(owner_username) OR photo_security.shared_person(person_id));
CREATE POLICY app_insert ON public.face_people FOR INSERT TO personal_photos_app WITH CHECK(photo_security.edits_people(owner_username));
CREATE POLICY app_update ON public.face_people FOR UPDATE TO personal_photos_app USING(photo_security.edits_people(owner_username)) WITH CHECK(photo_security.edits_people(owner_username));
CREATE POLICY app_delete ON public.face_people FOR DELETE TO personal_photos_app USING(photo_security.edits_people(owner_username));
GRANT SELECT(face_id,photo_id,owner_username,source,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,crop_path,ignored,created_by,created_at) ON public.faces TO personal_photos_app;
GRANT INSERT(photo_id,owner_username,source,box_x,box_y,box_w,box_h,created_by) ON public.faces TO personal_photos_app;
GRANT UPDATE(ignored,box_x,box_y,box_w,box_h) ON public.faces TO personal_photos_app;
GRANT DELETE ON public.faces TO personal_photos_app;
CREATE POLICY app_read ON public.faces FOR SELECT TO personal_photos_app USING(photo_security.owns_people(owner_username) OR photo_security.shared_face(face_id));
-- The app may only create manual tags, on photos it can edit, owned by the photo's album owner.
CREATE POLICY app_insert ON public.faces FOR INSERT TO personal_photos_app WITH CHECK(source='manual' AND created_by=photo_security.username()
 AND photo_security.edits_people(owner_username) AND photo_security.edit_photo(photo_id) AND owner_username=photo_security.photo_owner(photo_id));
-- Boxes are editable on manual tags only; detected faces keep scanner geometry.
CREATE POLICY app_update ON public.faces FOR UPDATE TO personal_photos_app USING(photo_security.edits_people(owner_username)) WITH CHECK(photo_security.edits_people(owner_username));
CREATE POLICY app_delete ON public.faces FOR DELETE TO personal_photos_app USING(photo_security.edits_people(owner_username));
CREATE FUNCTION photo_security.guard_detected_geometry() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 BEGIN
 IF OLD.source='detected' AND current_user='personal_photos_app'
 AND (NEW.box_x,NEW.box_y,NEW.box_w,NEW.box_h) IS DISTINCT FROM (OLD.box_x,OLD.box_y,OLD.box_w,OLD.box_h) THEN
  RAISE EXCEPTION 'detected face geometry is scanner-owned' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION photo_security.guard_detected_geometry() FROM PUBLIC;
CREATE TRIGGER guard_detected_geometry BEFORE UPDATE ON public.faces
 FOR EACH ROW EXECUTE FUNCTION photo_security.guard_detected_geometry();
GRANT SELECT,INSERT,UPDATE,DELETE ON public.face_assignments TO personal_photos_app;
CREATE POLICY app_read ON public.face_assignments FOR SELECT TO personal_photos_app USING(photo_security.owns_people(owner_username) OR photo_security.shared_face(face_id));
CREATE POLICY app_insert ON public.face_assignments FOR INSERT TO personal_photos_app WITH CHECK(photo_security.edits_people(owner_username));
CREATE POLICY app_update ON public.face_assignments FOR UPDATE TO personal_photos_app USING(photo_security.edits_people(owner_username)) WITH CHECK(photo_security.edits_people(owner_username));
CREATE POLICY app_delete ON public.face_assignments FOR DELETE TO personal_photos_app USING(photo_security.edits_people(owner_username));
GRANT SELECT,INSERT,DELETE ON public.face_rejections TO personal_photos_app;
CREATE POLICY app_read ON public.face_rejections FOR SELECT TO personal_photos_app USING(photo_security.owns_people(owner_username));
CREATE POLICY app_insert ON public.face_rejections FOR INSERT TO personal_photos_app WITH CHECK(photo_security.edits_people(owner_username));
CREATE POLICY app_delete ON public.face_rejections FOR DELETE TO personal_photos_app USING(photo_security.edits_people(owner_username));
GRANT SELECT,INSERT ON public.face_corrections TO personal_photos_app;
GRANT UPDATE(undone_at) ON public.face_corrections TO personal_photos_app;
CREATE POLICY app_read ON public.face_corrections FOR SELECT TO personal_photos_app USING(photo_security.owns_people(owner_username));
CREATE POLICY app_insert ON public.face_corrections FOR INSERT TO personal_photos_app WITH CHECK(photo_security.edits_people(owner_username) AND created_by=photo_security.username());
CREATE POLICY app_update ON public.face_corrections FOR UPDATE TO personal_photos_app USING(photo_security.edits_people(owner_username)) WITH CHECK(photo_security.edits_people(owner_username));
-- Scan operations are a main-administrator function, like video preparation.
GRANT SELECT,INSERT,UPDATE ON public.face_scan_runs TO personal_photos_app;
CREATE POLICY app_admin ON public.face_scan_runs TO personal_photos_app USING(photo_security.flag('main_admin')) WITH CHECK(photo_security.flag('main_admin') AND photo_security.flag('can_write'));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.face_scan_queue TO personal_photos_app;
CREATE POLICY app_read ON public.face_scan_queue FOR SELECT TO personal_photos_app USING(photo_security.owns_people(owner_username));
CREATE POLICY app_write ON public.face_scan_queue FOR INSERT TO personal_photos_app WITH CHECK(photo_security.edits_people(owner_username) AND photo_security.edit_photo(photo_id));
CREATE POLICY app_update ON public.face_scan_queue FOR UPDATE TO personal_photos_app USING(photo_security.edits_people(owner_username)) WITH CHECK(photo_security.edits_people(owner_username));
CREATE POLICY app_delete ON public.face_scan_queue FOR DELETE TO personal_photos_app USING(photo_security.edits_people(owner_username));

-- Face worker: reads catalog paths, publishes detections and conservative matches.
GRANT SELECT(photo_id,event_id,original_stage_path,media_type,ingest_status,width,height,orientation) ON public.photos TO personal_photos_face_worker;
GRANT SELECT(event_id,owner_username) ON public.events TO personal_photos_face_worker;
CREATE POLICY face_worker ON public.photos FOR SELECT TO personal_photos_face_worker USING(true);
CREATE POLICY face_worker ON public.events FOR SELECT TO personal_photos_face_worker USING(true);
GRANT SELECT ON public.face_settings,public.face_rejections TO personal_photos_face_worker;
GRANT SELECT,INSERT,UPDATE ON public.face_people TO personal_photos_face_worker;
GRANT SELECT,INSERT,DELETE ON public.faces TO personal_photos_face_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.face_assignments TO personal_photos_face_worker;
GRANT SELECT,UPDATE ON public.face_scan_runs,public.face_scan_queue TO personal_photos_face_worker;
GRANT INSERT ON public.stage_cleanup TO personal_photos_face_worker;
CREATE POLICY face_worker ON public.face_settings FOR SELECT TO personal_photos_face_worker USING(true);
CREATE POLICY face_worker ON public.face_rejections FOR SELECT TO personal_photos_face_worker USING(true);
CREATE POLICY face_worker ON public.face_people TO personal_photos_face_worker USING(true) WITH CHECK(true);
CREATE POLICY face_worker ON public.faces TO personal_photos_face_worker USING(true) WITH CHECK(true);
CREATE POLICY face_worker ON public.face_assignments TO personal_photos_face_worker USING(true) WITH CHECK(true);
CREATE POLICY face_worker ON public.face_scan_runs TO personal_photos_face_worker USING(true) WITH CHECK(true);
CREATE POLICY face_worker ON public.face_scan_queue TO personal_photos_face_worker USING(true) WITH CHECK(true);
CREATE POLICY face_worker ON public.stage_cleanup FOR INSERT TO personal_photos_face_worker WITH CHECK(true);

-- Maintenance keeps unrestricted repair access, matching every other table.
GRANT SELECT,INSERT,UPDATE,DELETE ON public.face_settings,public.face_people,public.faces,public.face_assignments,
 public.face_rejections,public.face_corrections,public.face_scan_runs,public.face_scan_queue TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.face_settings TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintenance ON public.face_people TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintenance ON public.faces TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintenance ON public.face_assignments TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintenance ON public.face_rejections TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintenance ON public.face_corrections TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintenance ON public.face_scan_runs TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintenance ON public.face_scan_queue TO personal_photos_maintenance USING(true) WITH CHECK(true);
