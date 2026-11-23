--
-- PostgreSQL database dump
--



-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = on;

--
-- Name: snowflake_auth; Type: EXTENSION; Schema: -; Owner: -
--




--
-- Name: EXTENSION snowflake_auth; Type: COMMENT; Schema: -; Owner: -
--




--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--




--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner: -
--




--
-- Name: pgaudit; Type: EXTENSION; Schema: -; Owner: -
--




--
-- Name: EXTENSION pgaudit; Type: COMMENT; Schema: -; Owner: -
--




--
-- Name: enqueue_video_playback(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_video_playback() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.media_type='video' AND NEW.ingest_status='READY' AND NEW.original_stage_path IS NOT NULL THEN
  INSERT INTO video_playback(photo_id,original_path) VALUES(NEW.photo_id,NEW.original_stage_path)
  ON CONFLICT(photo_id) DO UPDATE SET original_path=EXCLUDED.original_path,status='queued',attempts=0,claim_token=NULL,lease_until=NULL,next_attempt_at=NOW(),requested_at=NOW()
  WHERE video_playback.original_path IS DISTINCT FROM EXCLUDED.original_path;
 END IF;
 RETURN NEW;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    event_id integer NOT NULL,
    sort_order integer NOT NULL,
    event_name character varying(255) NOT NULL,
    source_folder character varying(512) NOT NULL,
    event_month smallint,
    event_year smallint,
    cover_photo_id integer,
    photo_count integer DEFAULT 0,
    visibility character varying(50) DEFAULT 'PRIVATE'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    location character varying(255),
    folder_id integer,
    search_vector tsvector,
    owner_username text DEFAULT 'EXAMPLEADMIN'::text NOT NULL
);


--
-- Name: event_search_text(public.events); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.event_search_text(e public.events) RETURNS text
    LANGUAGE sql STABLE
    AS $$
 SELECT concat_ws(' ', e.event_name, e.location, e.event_year::text,
 CASE WHEN e.event_month BETWEEN 1 AND 12 THEN
 (ARRAY['January','February','March','April','May','June','July','August','September','October','November','December'])[e.event_month] END)
$$;


--
-- Name: prepare_event_search(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_event_search() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.search_vector := to_tsvector('english', event_search_text(NEW)); RETURN NEW; END $$;


--
-- Name: prepare_photo_search(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_photo_search() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE event_text TEXT; video_text TEXT;
BEGIN
 SELECT event_search_text(e) INTO event_text FROM events e WHERE e.event_id=NEW.event_id;
 SELECT search_text INTO video_text FROM video_analyses WHERE photo_id=NEW.photo_id AND status='completed' ORDER BY created_at DESC LIMIT 1;
 NEW.search_vector := to_tsvector('english',concat_ws(' ',NEW.source_filename,NEW.ai_description,
 array_to_string(NEW.ai_tags,' '),array_to_string(NEW.user_tags,' '),array_to_string(NEW.iptc_keywords,' '),NEW.caption,
 NEW.camera_make,NEW.camera_model,NEW.lens_model,NEW.country,NEW.region,NEW.city,NEW.location_name,event_text,video_text));
 RETURN NEW;
END $$;


--
-- Name: queue_search_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.queue_search_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE item_id INTEGER;
BEGIN
 IF TG_TABLE_NAME = 'photos' THEN
   item_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.photo_id ELSE NEW.photo_id END;
 ELSE
   item_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END;
 END IF;
 INSERT INTO search_queue(kind,id) VALUES (TG_ARGV[0],item_id)
 ON CONFLICT(kind,id) DO UPDATE SET revision=nextval('search_revision'), queued_at=NOW();
 RETURN NULL;
END $$;


--
-- Name: refresh_event_photos(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_event_photos() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF (NEW.event_name,NEW.location,NEW.event_month,NEW.event_year) IS DISTINCT FROM (OLD.event_name,OLD.location,OLD.event_month,OLD.event_year) THEN
   UPDATE photos SET updated_at=NOW() WHERE event_id=NEW.event_id;
 END IF;
 RETURN NULL;
END $$;


--
-- Name: retire_video_playback(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.retire_video_playback() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM photos WHERE photo_id=OLD.photo_id)
 AND NOT EXISTS(SELECT 1 FROM photo_trash WHERE photo_id=OLD.photo_id) THEN
  WITH removed AS (DELETE FROM video_playback WHERE photo_id=OLD.photo_id RETURNING stage_path,renditions)
  INSERT INTO stage_cleanup(path,next_attempt) SELECT path,NOW()+INTERVAL '24 hours' FROM (
   SELECT stage_path path FROM removed UNION SELECT r->>'stage_path' FROM removed CROSS JOIN LATERAL jsonb_array_elements(renditions) r
  ) paths WHERE path IS NOT NULL ON CONFLICT DO NOTHING;
 END IF;
 RETURN OLD;
END $$;


--
-- Name: set_trash_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_trash_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.owner_username IS NULL THEN
  SELECT owner_username INTO NEW.owner_username FROM events WHERE event_id=(NEW.photo_data->>'event_id')::int;
 END IF;
 IF NEW.owner_username IS NULL THEN RAISE EXCEPTION 'Trash owner is required'; END IF;
 RETURN NEW;
END $$;


--
-- Name: summarize_user_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.summarize_user_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.occurred_at < (now() AT TIME ZONE 'UTC')::date-interval '12 months' THEN RETURN NEW; END IF;
 INSERT INTO user_activity_daily AS d VALUES(
 (NEW.occurred_at AT TIME ZONE 'UTC')::date,NEW.username,NEW.kind,COALESCE(NEW.details->>'provider',NEW.source),1,
 COALESCE((NEW.details->>'seconds')::numeric,0),COALESCE((NEW.details->>'bytes')::numeric,0),COALESCE((NEW.details->>'files')::numeric,0),
 CASE WHEN NEW.details->>'outcome'='success' THEN 1 ELSE 0 END,CASE WHEN NEW.details->>'outcome'='failed' THEN 1 ELSE 0 END,CASE WHEN NEW.details->>'outcome'='skipped' THEN 1 ELSE 0 END,
 COALESCE((NEW.details->>'durationMs')::numeric,0),COALESCE((NEW.details->>'results')::numeric,0))
 ON CONFLICT(day,username,kind,provider) DO UPDATE SET events=d.events+1,seconds=d.seconds+EXCLUDED.seconds,bytes=d.bytes+EXCLUDED.bytes,files=d.files+EXCLUDED.files,
 successes=d.successes+EXCLUDED.successes,failures=d.failures+EXCLUDED.failures,skipped=d.skipped+EXCLUDED.skipped,duration_ms=d.duration_ms+EXCLUDED.duration_ms,results=d.results+EXCLUDED.results;
 RETURN NEW;
END $$;


--
-- Name: album_location_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.album_location_changes (
    id uuid NOT NULL,
    event_id integer NOT NULL,
    label text NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    applied_by text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    undone_at timestamp with time zone
);


--
-- Name: album_location_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.album_location_items (
    change_id uuid NOT NULL,
    photo_id integer NOT NULL,
    previous jsonb NOT NULL
);


--
-- Name: album_public_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.album_public_links (
    id uuid NOT NULL,
    event_id integer NOT NULL,
    token_hash text NOT NULL,
    owner_username text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    allow_downloads boolean DEFAULT false NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: album_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.album_shares (
    event_id integer NOT NULL,
    username text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_reports (
    name text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    refreshed_at timestamp with time zone,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cost_index_weights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_index_weights (
    work_id uuid NOT NULL,
    service text NOT NULL,
    username text NOT NULL,
    units bigint NOT NULL,
    phase text DEFAULT 'merge'::text NOT NULL,
    CONSTRAINT cost_index_weights_units_check CHECK ((units > 0))
);


--
-- Name: cost_work; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_work (
    id uuid NOT NULL,
    category text NOT NULL,
    owners jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cost_work_category_check CHECK ((category = ANY (ARRAY['ai'::text, 'photo_ai'::text, 'video_ai'::text, 'search_indexing'::text, 'warehouse'::text])))
);


--
-- Name: events_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.events_event_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: events_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.events_event_id_seq OWNED BY public.events.event_id;


--
-- Name: folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.folders (
    folder_id integer NOT NULL,
    folder_name character varying(255) NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    owner_username text
);


--
-- Name: folders_folder_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.folders_folder_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: folders_folder_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.folders_folder_id_seq OWNED BY public.folders.folder_id;


--
-- Name: gallery_access_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gallery_access_objects (
    kind text NOT NULL,
    name text NOT NULL,
    marker uuid NOT NULL,
    profile text,
    display_name text NOT NULL,
    email text,
    created_by text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    auth0_user_id text,
    deleting boolean DEFAULT false NOT NULL,
    CONSTRAINT gallery_access_objects_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'role'::text]))),
    CONSTRAINT gallery_access_objects_profile_check CHECK ((profile = ANY (ARRAY['viewer'::text, 'admin'::text, 'admin_readonly'::text]))),
    CONSTRAINT gallery_access_objects_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'ready'::text])))
);


--
-- Name: gallery_access_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gallery_access_operations (
    id uuid NOT NULL,
    actor text NOT NULL,
    request jsonb NOT NULL,
    state text NOT NULL,
    result jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gallery_access_operations_state_check CHECK ((state = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: gallery_main_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gallery_main_admins (
    username text NOT NULL
);


--
-- Name: gallery_revoked_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gallery_revoked_sessions (
    sid uuid NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '12:05:00'::interval) NOT NULL
);


--
-- Name: identity_log_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_log_sync (
    provider text NOT NULL,
    cursor text,
    attempted_at timestamp with time zone,
    completed_at timestamp with time zone,
    imported integer DEFAULT 0 NOT NULL,
    scanned integer DEFAULT 0 NOT NULL,
    error text,
    more boolean DEFAULT false NOT NULL,
    CONSTRAINT identity_log_sync_provider_check CHECK ((provider = ANY (ARRAY['auth0'::text, 'snowflake'::text])))
);


--
-- Name: maintenance_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_state (
    name text NOT NULL,
    next_run timestamp with time zone DEFAULT now() NOT NULL,
    last_success timestamp with time zone,
    last_error text
);


--
-- Name: photo_trash; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.photo_trash (
    photo_id integer NOT NULL,
    photo_data jsonb NOT NULL,
    album_name text NOT NULL,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    owner_username text NOT NULL
);


--
-- Name: photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.photos (
    photo_id integer NOT NULL,
    event_id integer NOT NULL,
    source_filename character varying(512) NOT NULL,
    source_relative_path character varying(1024),
    original_stage_path character varying(1024),
    display_stage_path character varying(1024),
    thumbnail_stage_path character varying(1024),
    file_size_bytes bigint,
    content_type character varying(100),
    file_extension character varying(20),
    file_hash character varying(64),
    stage_etag character varying(255),
    width integer,
    height integer,
    aspect_ratio real,
    orientation smallint,
    date_taken timestamp with time zone,
    date_taken_raw character varying(255),
    camera_make character varying(255),
    camera_model character varying(255),
    lens_model character varying(255),
    focal_length character varying(50),
    aperture character varying(50),
    shutter_speed character varying(50),
    iso integer,
    exposure_compensation character varying(50),
    flash_used boolean,
    latitude double precision,
    longitude double precision,
    altitude double precision,
    gps_direction double precision,
    country character varying(255),
    region character varying(255),
    city character varying(255),
    location_name character varying(255),
    exif_raw jsonb,
    xmp_raw jsonb,
    caption text,
    ai_description text,
    favorite boolean DEFAULT false,
    rating smallint,
    visibility character varying(50) DEFAULT 'PRIVATE'::character varying,
    ingest_status character varying(50) DEFAULT 'DISCOVERED'::character varying,
    ingest_error text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    media_type character varying(10) DEFAULT 'photo'::character varying,
    duration real,
    lens_make character varying(255),
    lens_serial character varying(255),
    software character varying(255),
    artist character varying(255),
    copyright character varying(512),
    exposure_program character varying(50),
    metering_mode character varying(50),
    light_source character varying(50),
    white_balance character varying(50),
    exposure_mode character varying(50),
    scene_capture_type character varying(50),
    contrast character varying(50),
    saturation character varying(50),
    sharpness character varying(50),
    brightness character varying(50),
    focal_length_35mm character varying(50),
    digital_zoom_ratio character varying(50),
    color_space character varying(50),
    subject_distance_range character varying(50),
    gps_speed double precision,
    gps_timestamp timestamp with time zone,
    gps_h_positioning_error double precision,
    iptc_keywords text[],
    iptc_headline character varying(255),
    iptc_copyright character varying(512),
    iptc_raw jsonb,
    icc_raw jsonb,
    ai_tags text[],
    ai_error character varying(500),
    search_synced_at timestamp with time zone,
    ai_attempts integer DEFAULT 0 NOT NULL,
    ai_next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    ai_lease_until timestamp with time zone,
    ai_claim uuid,
    search_vector tsvector,
    user_tags text[] DEFAULT '{}'::text[],
    ai_prompt_version text,
    location_assignment_id uuid
);


--
-- Name: COLUMN photos.ai_prompt_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.photos.ai_prompt_version IS 'Description provenance: legacy or v2-factual. Duplicate reuse preserves source version.';


--
-- Name: photos_photo_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.photos_photo_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: photos_photo_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.photos_photo_id_seq OWNED BY public.photos.photo_id;


--
-- Name: search_revision; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.search_revision
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: search_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_queue (
    kind text NOT NULL,
    id integer NOT NULL,
    revision bigint DEFAULT nextval('public.search_revision'::regclass) NOT NULL,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_queue_kind_check CHECK ((kind = ANY (ARRAY['photo'::text, 'event'::text])))
);


--
-- Name: stage_cleanup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stage_cleanup (
    path text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt timestamp with time zone DEFAULT now() NOT NULL,
    last_error text
);


--
-- Name: storage_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_snapshots (
    day date NOT NULL,
    active_bytes bigint NOT NULL,
    trash_bytes bigint NOT NULL,
    media_count integer NOT NULL,
    sampled_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: travel_lookup_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.travel_lookup_settings (
    id integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    endpoint text DEFAULT 'https://nominatim.openstreetmap.org/reverse'::text NOT NULL,
    next_request_at timestamp with time zone DEFAULT now() NOT NULL,
    search_endpoint text DEFAULT 'https://nominatim.openstreetmap.org/search'::text NOT NULL,
    CONSTRAINT travel_lookup_settings_id_check CHECK ((id = 1))
);


--
-- Name: travel_place_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.travel_place_cache (
    area_id text NOT NULL,
    label text,
    city text,
    region text,
    country text,
    retry_after timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: travel_search_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.travel_search_cache (
    query text NOT NULL,
    results jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: upload_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_chunks (
    upload_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    data bytea,
    hash text NOT NULL,
    stage_path text,
    byte_size integer,
    CONSTRAINT upload_chunks_chunk_index_check CHECK (((chunk_index >= 0) AND (chunk_index <= 511))),
    CONSTRAINT upload_chunks_data_check CHECK (((octet_length(data) >= 1) AND (octet_length(data) <= 8388608))),
    CONSTRAINT upload_chunks_storage CHECK ((((data IS NOT NULL) AND (stage_path IS NULL)) OR ((data IS NULL) AND (stage_path IS NOT NULL) AND ((byte_size >= 1) AND (byte_size <= 8388608)))))
);


--
-- Name: upload_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_files (
    upload_file_id integer NOT NULL,
    upload_job_id integer NOT NULL,
    photo_id integer,
    source_filename character varying(512) NOT NULL,
    file_hash character varying(64),
    stage_path character varying(1024),
    status character varying(50) DEFAULT 'PENDING'::character varying,
    error_message text,
    file_size_bytes bigint,
    started_at timestamp with time zone,
    completed_at timestamp with time zone
);


--
-- Name: upload_files_upload_file_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.upload_files_upload_file_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: upload_files_upload_file_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.upload_files_upload_file_id_seq OWNED BY public.upload_files.upload_file_id;


--
-- Name: upload_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_jobs (
    upload_job_id integer NOT NULL,
    event_id integer,
    source_folder character varying(512),
    started_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    file_count integer DEFAULT 0,
    success_count integer DEFAULT 0,
    skipped_count integer DEFAULT 0,
    failed_count integer DEFAULT 0,
    total_bytes bigint DEFAULT 0,
    status character varying(50) DEFAULT 'PENDING'::character varying
);


--
-- Name: upload_jobs_upload_job_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.upload_jobs_upload_job_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: upload_jobs_upload_job_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.upload_jobs_upload_job_id_seq OWNED BY public.upload_jobs.upload_job_id;


--
-- Name: upload_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_sessions (
    upload_id uuid NOT NULL,
    owner text NOT NULL,
    total_chunks integer NOT NULL,
    bytes bigint DEFAULT 0 NOT NULL,
    metadata jsonb,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    completion_token uuid,
    completion_lease_until timestamp with time zone,
    CONSTRAINT upload_sessions_bytes_check CHECK (((bytes >= 0) AND (bytes <= '4294967296'::bigint))),
    CONSTRAINT upload_sessions_total_chunks_check CHECK (((total_chunks >= 1) AND (total_chunks <= 512)))
);


--
-- Name: upload_start_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_start_limits (
    owner text NOT NULL,
    window_start timestamp with time zone DEFAULT now() NOT NULL,
    starts integer NOT NULL,
    CONSTRAINT upload_start_limits_starts_check CHECK ((starts > 0))
);


--
-- Name: user_activity_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_activity_daily (
    day date NOT NULL,
    username text NOT NULL,
    kind text NOT NULL,
    provider text NOT NULL,
    events bigint DEFAULT 0 NOT NULL,
    seconds numeric DEFAULT 0 NOT NULL,
    bytes numeric DEFAULT 0 NOT NULL,
    files numeric DEFAULT 0 NOT NULL,
    successes bigint DEFAULT 0 NOT NULL,
    failures bigint DEFAULT 0 NOT NULL,
    skipped bigint DEFAULT 0 NOT NULL,
    duration_ms numeric DEFAULT 0 NOT NULL,
    results numeric DEFAULT 0 NOT NULL
);


--
-- Name: user_activity_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_activity_events (
    event_id uuid NOT NULL,
    username text NOT NULL,
    session_id uuid,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text NOT NULL,
    target text DEFAULT ''::text NOT NULL,
    source text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT user_activity_events_source_check CHECK ((source = ANY (ARRAY['browser'::text, 'server'::text])))
);


--
-- Name: user_activity_maintenance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_activity_maintenance (
    id integer NOT NULL,
    cleaned_at timestamp with time zone NOT NULL,
    CONSTRAINT user_activity_maintenance_id_check CHECK ((id = 1))
);


--
-- Name: user_activity_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_activity_sessions (
    session_id uuid NOT NULL,
    username text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_folder_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_folder_state (
    username text NOT NULL,
    folder_id integer NOT NULL,
    expanded boolean DEFAULT true NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    user_id integer NOT NULL,
    username character varying(100) NOT NULL,
    display_name character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    role character varying(20) DEFAULT 'viewer'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    last_login timestamp with time zone
);


--
-- Name: users_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_user_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_user_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_user_id_seq OWNED BY public.users.user_id;


--
-- Name: video_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_analyses (
    id uuid NOT NULL,
    photo_id integer NOT NULL,
    requested_by text NOT NULL,
    owner_username text NOT NULL,
    model text NOT NULL,
    prompt_version text NOT NULL,
    status text NOT NULL,
    result jsonb,
    search_text text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    phase text,
    compressed boolean DEFAULT false NOT NULL,
    analysis_bytes bigint,
    lease_until timestamp with time zone,
    claim_token uuid,
    CONSTRAINT video_analyses_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: video_playback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_playback (
    photo_id integer NOT NULL,
    original_path text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    stage_path text,
    playlist text,
    file_bytes bigint,
    attempts integer DEFAULT 0 NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    completed_at timestamp with time zone,
    error text,
    renditions jsonb DEFAULT '[]'::jsonb NOT NULL,
    format_version integer DEFAULT 1 NOT NULL,
    claim_token uuid,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    preparation_run_id uuid,
    CONSTRAINT video_playback_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'ready'::text, 'failed'::text])))
);


--
-- Name: video_preparation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_preparation_runs (
    id uuid NOT NULL,
    requested_by text NOT NULL,
    status text NOT NULL,
    total integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    error text,
    CONSTRAINT video_preparation_runs_status_check CHECK ((status = ANY (ARRAY['starting'::text, 'running'::text, 'completed'::text, 'attention'::text])))
);


--
-- Name: events event_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events ALTER COLUMN event_id SET DEFAULT nextval('public.events_event_id_seq'::regclass);


--
-- Name: folders folder_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folders ALTER COLUMN folder_id SET DEFAULT nextval('public.folders_folder_id_seq'::regclass);


--
-- Name: photos photo_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.photos ALTER COLUMN photo_id SET DEFAULT nextval('public.photos_photo_id_seq'::regclass);


--
-- Name: upload_files upload_file_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_files ALTER COLUMN upload_file_id SET DEFAULT nextval('public.upload_files_upload_file_id_seq'::regclass);


--
-- Name: upload_jobs upload_job_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_jobs ALTER COLUMN upload_job_id SET DEFAULT nextval('public.upload_jobs_upload_job_id_seq'::regclass);


--
-- Name: users user_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN user_id SET DEFAULT nextval('public.users_user_id_seq'::regclass);


--
-- Name: album_location_changes album_location_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.album_location_changes
    ADD CONSTRAINT album_location_changes_pkey PRIMARY KEY (id);


--
-- Name: album_location_items album_location_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.album_location_items
    ADD CONSTRAINT album_location_items_pkey PRIMARY KEY (change_id, photo_id);


--
-- Name: album_public_links album_public_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.album_public_links
    ADD CONSTRAINT album_public_links_pkey PRIMARY KEY (id);


--
-- Name: album_public_links album_public_links_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.album_public_links
    ADD CONSTRAINT album_public_links_token_hash_key UNIQUE (token_hash);


--
-- Name: album_shares album_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.album_shares
    ADD CONSTRAINT album_shares_pkey PRIMARY KEY (event_id, username);


--
-- Name: app_reports app_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_reports
    ADD CONSTRAINT app_reports_pkey PRIMARY KEY (name);


--
-- Name: cost_index_weights cost_index_weights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_index_weights
    ADD CONSTRAINT cost_index_weights_pkey PRIMARY KEY (work_id, service, username);


--
-- Name: cost_work cost_work_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_work
    ADD CONSTRAINT cost_work_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (event_id);


--
-- Name: folders folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT folders_pkey PRIMARY KEY (folder_id);


--
-- Name: gallery_access_objects gallery_access_objects_marker_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gallery_access_objects
    ADD CONSTRAINT gallery_access_objects_marker_key UNIQUE (marker);


--
-- Name: gallery_access_objects gallery_access_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gallery_access_objects
    ADD CONSTRAINT gallery_access_objects_pkey PRIMARY KEY (kind, name);


--
-- Name: gallery_access_operations gallery_access_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gallery_access_operations
    ADD CONSTRAINT gallery_access_operations_pkey PRIMARY KEY (id);


--
-- Name: gallery_main_admins gallery_main_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gallery_main_admins
    ADD CONSTRAINT gallery_main_admins_pkey PRIMARY KEY (username);


--
-- Name: gallery_revoked_sessions gallery_revoked_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gallery_revoked_sessions
    ADD CONSTRAINT gallery_revoked_sessions_pkey PRIMARY KEY (sid);


--
-- Name: identity_log_sync identity_log_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_log_sync
    ADD CONSTRAINT identity_log_sync_pkey PRIMARY KEY (provider);


--
-- Name: maintenance_state maintenance_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_state
    ADD CONSTRAINT maintenance_state_pkey PRIMARY KEY (name);


--
-- Name: photo_trash photo_trash_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.photo_trash
    ADD CONSTRAINT photo_trash_pkey PRIMARY KEY (photo_id);


--
-- Name: photos photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.photos
    ADD CONSTRAINT photos_pkey PRIMARY KEY (photo_id);


--
-- Name: search_queue search_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_queue
    ADD CONSTRAINT search_queue_pkey PRIMARY KEY (kind, id);


--
-- Name: stage_cleanup stage_cleanup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_cleanup
    ADD CONSTRAINT stage_cleanup_pkey PRIMARY KEY (path);


--
-- Name: storage_snapshots storage_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_snapshots
    ADD CONSTRAINT storage_snapshots_pkey PRIMARY KEY (day);


--
-- Name: travel_lookup_settings travel_lookup_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travel_lookup_settings
    ADD CONSTRAINT travel_lookup_settings_pkey PRIMARY KEY (id);


--
-- Name: travel_place_cache travel_place_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travel_place_cache
    ADD CONSTRAINT travel_place_cache_pkey PRIMARY KEY (area_id);


--
-- Name: travel_search_cache travel_search_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travel_search_cache
    ADD CONSTRAINT travel_search_cache_pkey PRIMARY KEY (query);


--
-- Name: upload_chunks upload_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_chunks
    ADD CONSTRAINT upload_chunks_pkey PRIMARY KEY (upload_id, chunk_index);


--
-- Name: upload_files upload_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_files
    ADD CONSTRAINT upload_files_pkey PRIMARY KEY (upload_file_id);


--
-- Name: upload_jobs upload_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_jobs
    ADD CONSTRAINT upload_jobs_pkey PRIMARY KEY (upload_job_id);


--
-- Name: upload_sessions upload_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_pkey PRIMARY KEY (upload_id);


--
-- Name: upload_start_limits upload_start_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_start_limits
    ADD CONSTRAINT upload_start_limits_pkey PRIMARY KEY (owner);


--
-- Name: user_activity_daily user_activity_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_activity_daily
    ADD CONSTRAINT user_activity_daily_pkey PRIMARY KEY (day, username, kind, provider);


--
-- Name: user_activity_events user_activity_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_activity_events
    ADD CONSTRAINT user_activity_events_pkey PRIMARY KEY (event_id);


--
-- Name: user_activity_maintenance user_activity_maintenance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_activity_maintenance
    ADD CONSTRAINT user_activity_maintenance_pkey PRIMARY KEY (id);


--
-- Name: user_activity_sessions user_activity_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_activity_sessions
    ADD CONSTRAINT user_activity_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: user_folder_state user_folder_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_folder_state
    ADD CONSTRAINT user_folder_state_pkey PRIMARY KEY (username, folder_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: video_analyses video_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_analyses
    ADD CONSTRAINT video_analyses_pkey PRIMARY KEY (id);


--
-- Name: video_playback video_playback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_playback
    ADD CONSTRAINT video_playback_pkey PRIMARY KEY (photo_id);


--
-- Name: video_preparation_runs video_preparation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_preparation_runs
    ADD CONSTRAINT video_preparation_runs_pkey PRIMARY KEY (id);


--
-- Name: album_public_links_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX album_public_links_event ON public.album_public_links USING btree (event_id);


--
-- Name: album_shares_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX album_shares_user ON public.album_shares USING btree (username, event_id);


--
-- Name: cost_work_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cost_work_time ON public.cost_work USING btree (created_at);


--
-- Name: events_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_owner ON public.events USING btree (owner_username);


--
-- Name: events_page_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_page_sort_idx ON public.events USING btree (COALESCE(sort_order, 0), event_id);


--
-- Name: events_search_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_search_gin ON public.events USING gin (search_vector);


--
-- Name: gallery_access_auth0_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX gallery_access_auth0_identity ON public.gallery_access_objects USING btree (auth0_user_id) WHERE (auth0_user_id IS NOT NULL);


--
-- Name: gallery_access_operations_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gallery_access_operations_recent ON public.gallery_access_operations USING btree (created_at DESC);


--
-- Name: gallery_revoked_sessions_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gallery_revoked_sessions_expiry ON public.gallery_revoked_sessions USING btree (expires_at);


--
-- Name: idx_events_folder_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_folder_id ON public.events USING btree (folder_id);


--
-- Name: idx_events_sort_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_sort_order ON public.events USING btree (sort_order);


--
-- Name: idx_events_source_folder_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_events_source_folder_unique ON public.events USING btree (source_folder);


--
-- Name: idx_folders_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_folders_owner ON public.folders USING btree (owner_username);


--
-- Name: idx_photos_date_taken; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_photos_date_taken ON public.photos USING btree (date_taken);


--
-- Name: idx_photos_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_photos_event_id ON public.photos USING btree (event_id);


--
-- Name: idx_photos_file_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_photos_file_hash ON public.photos USING btree (file_hash);


--
-- Name: idx_photos_ingest_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_photos_ingest_status ON public.photos USING btree (ingest_status);


--
-- Name: photo_trash_display; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photo_trash_display ON public.photo_trash USING btree (((photo_data ->> 'display_stage_path'::text)));


--
-- Name: photo_trash_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photo_trash_expiry ON public.photo_trash USING btree (expires_at);


--
-- Name: photo_trash_original; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photo_trash_original ON public.photo_trash USING btree (((photo_data ->> 'original_stage_path'::text)));


--
-- Name: photo_trash_thumbnail; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photo_trash_thumbnail ON public.photo_trash USING btree (((photo_data ->> 'thumbnail_stage_path'::text)));


--
-- Name: photos_ai_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_ai_pending ON public.photos USING btree (ai_next_attempt_at) WHERE ((ai_description IS NULL) AND ((ingest_status)::text = 'READY'::text));


--
-- Name: photos_display_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_display_path ON public.photos USING btree (display_stage_path);


--
-- Name: photos_event_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_event_date ON public.photos USING btree (event_id, date_taken, photo_id);


--
-- Name: photos_event_gps_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_event_gps_idx ON public.photos USING btree (event_id, latitude, longitude) WHERE ((latitude IS NOT NULL) AND (longitude IS NOT NULL));


--
-- Name: photos_event_hash_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX photos_event_hash_unique ON public.photos USING btree (event_id, file_hash) WHERE (file_hash IS NOT NULL);


--
-- Name: photos_favorites; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_favorites ON public.photos USING btree (photo_id) WHERE ((favorite = true) AND ((ingest_status)::text = 'READY'::text));


--
-- Name: photos_original_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_original_path ON public.photos USING btree (original_stage_path);


--
-- Name: photos_search_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_search_gin ON public.photos USING gin (search_vector);


--
-- Name: photos_thumbnail_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_thumbnail_path ON public.photos USING btree (thumbnail_stage_path);


--
-- Name: upload_chunks_stage_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upload_chunks_stage_path ON public.upload_chunks USING btree (stage_path) WHERE (stage_path IS NOT NULL);


--
-- Name: upload_completion_leases; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upload_completion_leases ON public.upload_sessions USING btree (completion_lease_until) WHERE ((result IS NULL) AND (completion_token IS NOT NULL));


--
-- Name: upload_sessions_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upload_sessions_expiry ON public.upload_sessions USING btree (expires_at);


--
-- Name: user_activity_events_kind_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_activity_events_kind_time ON public.user_activity_events USING btree (kind, occurred_at DESC);


--
-- Name: user_activity_events_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_activity_events_time ON public.user_activity_events USING btree (occurred_at DESC);


--
-- Name: user_activity_events_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_activity_events_timeline ON public.user_activity_events USING btree (username, occurred_at DESC, event_id DESC);


--
-- Name: user_activity_events_user_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_activity_events_user_time ON public.user_activity_events USING btree (username, occurred_at DESC);


--
-- Name: user_activity_sessions_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_activity_sessions_seen ON public.user_activity_sessions USING btree (last_seen);


--
-- Name: video_analyses_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX video_analyses_active ON public.video_analyses USING btree (photo_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: video_analyses_photo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX video_analyses_photo ON public.video_analyses USING btree (photo_id, created_at DESC);


--
-- Name: video_playback_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX video_playback_due ON public.video_playback USING btree (next_attempt_at, requested_at) WHERE (status = 'queued'::text);


--
-- Name: video_playback_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX video_playback_queue ON public.video_playback USING btree (status, requested_at);


--
-- Name: video_playback_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX video_playback_run ON public.video_playback USING btree (preparation_run_id) WHERE (preparation_run_id IS NOT NULL);


--
-- Name: video_preparation_single_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX video_preparation_single_active ON public.video_preparation_runs USING btree ((true)) WHERE (status = ANY (ARRAY['starting'::text, 'running'::text]));


--
-- Name: photos enqueue_video_playback; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enqueue_video_playback AFTER INSERT OR UPDATE OF original_stage_path, ingest_status ON public.photos FOR EACH ROW EXECUTE FUNCTION public.enqueue_video_playback();


--
-- Name: events event_photo_search_refresh; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER event_photo_search_refresh AFTER UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.refresh_event_photos();


--
-- Name: events event_search_prepare; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER event_search_prepare BEFORE INSERT OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.prepare_event_search();


--
-- Name: events event_search_queue; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER event_search_queue AFTER INSERT OR DELETE OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.queue_search_change('event');


--
-- Name: photos photo_search_prepare; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER photo_search_prepare BEFORE INSERT OR UPDATE OF source_filename, ai_description, ai_tags, user_tags, iptc_keywords, caption, camera_make, camera_model, lens_model, country, region, city, location_name, event_id, updated_at ON public.photos FOR EACH ROW EXECUTE FUNCTION public.prepare_photo_search();


--
-- Name: photos photo_search_queue; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER photo_search_queue AFTER INSERT OR DELETE OR UPDATE OF updated_at ON public.photos FOR EACH ROW EXECUTE FUNCTION public.queue_search_change('photo');


--
-- Name: photo_trash photo_trash_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER photo_trash_owner BEFORE INSERT ON public.photo_trash FOR EACH ROW EXECUTE FUNCTION public.set_trash_owner();


--
-- Name: photo_trash retire_video_playback; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER retire_video_playback AFTER DELETE ON public.photo_trash FOR EACH ROW EXECUTE FUNCTION public.retire_video_playback();


--
-- Name: photos retire_video_playback; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER retire_video_playback AFTER DELETE ON public.photos FOR EACH ROW EXECUTE FUNCTION public.retire_video_playback();


--
-- Name: user_activity_events user_activity_summary_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_activity_summary_insert AFTER INSERT ON public.user_activity_events FOR EACH ROW EXECUTE FUNCTION public.summarize_user_activity();


--
-- Name: album_location_changes album_location_changes_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.album_location_changes
    ADD CONSTRAINT album_location_changes_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(event_id) ON DELETE CASCADE;


--
-- Name: album_location_items album_location_items_change_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.album_location_items
    ADD CONSTRAINT album_location_items_change_id_fkey FOREIGN KEY (change_id) REFERENCES public.album_location_changes(id) ON DELETE CASCADE;


--
-- Name: album_public_links album_public_links_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.album_public_links
    ADD CONSTRAINT album_public_links_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(event_id) ON DELETE CASCADE;


--
-- Name: album_shares album_shares_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.album_shares
    ADD CONSTRAINT album_shares_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(event_id) ON DELETE CASCADE;


--
-- Name: cost_index_weights cost_index_weights_work_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_index_weights
    ADD CONSTRAINT cost_index_weights_work_id_fkey FOREIGN KEY (work_id) REFERENCES public.cost_work(id) ON DELETE CASCADE;


--
-- Name: events events_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(folder_id);


--
-- Name: photos photos_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.photos
    ADD CONSTRAINT photos_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(event_id);


--
-- Name: upload_chunks upload_chunks_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_chunks
    ADD CONSTRAINT upload_chunks_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.upload_sessions(upload_id) ON DELETE CASCADE;


--
-- Name: upload_files upload_files_upload_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_files
    ADD CONSTRAINT upload_files_upload_job_id_fkey FOREIGN KEY (upload_job_id) REFERENCES public.upload_jobs(upload_job_id);


--
-- Name: user_folder_state user_folder_state_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_folder_state
    ADD CONSTRAINT user_folder_state_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(folder_id) ON DELETE CASCADE;


--
-- Name: video_playback video_playback_preparation_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_playback
    ADD CONSTRAINT video_playback_preparation_run_id_fkey FOREIGN KEY (preparation_run_id) REFERENCES public.video_preparation_runs(id);


--
-- Name: album_shares; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.album_shares ENABLE ROW LEVEL SECURITY;

--
-- Name: album_shares catalog_reader; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_reader ON public.album_shares FOR SELECT TO personal_photos_reader USING ((username = NULLIF(current_setting('photos.username'::text, true), ''::text)));


--
-- Name: events catalog_reader; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_reader ON public.events FOR SELECT TO personal_photos_reader USING (((NULLIF(current_setting('photos.username'::text, true), ''::text) IS NOT NULL) AND ((current_setting('photos.main_admin'::text, true) = 'true'::text) OR (owner_username = current_setting('photos.username'::text, true)) OR ((visibility)::text = 'GALLERY'::text) OR (event_id IN ( SELECT album_shares.event_id
   FROM public.album_shares)))));


--
-- Name: photos catalog_reader; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_reader ON public.photos FOR SELECT TO personal_photos_reader USING ((event_id IN ( SELECT events.event_id
   FROM public.events)));


--
-- Name: album_shares catalog_runtime; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_runtime ON public.album_shares TO personal_photos_app USING (true) WITH CHECK (true);


--
-- Name: events catalog_runtime; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_runtime ON public.events TO personal_photos_app USING (true) WITH CHECK (true);


--
-- Name: photos catalog_runtime; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_runtime ON public.photos TO personal_photos_app USING (true) WITH CHECK (true);


--
-- Name: events catalog_worker; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_worker ON public.events FOR SELECT TO personal_photos_video_worker USING (true);


--
-- Name: photos catalog_worker; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_worker ON public.photos FOR SELECT TO personal_photos_video_worker USING (true);


--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--



