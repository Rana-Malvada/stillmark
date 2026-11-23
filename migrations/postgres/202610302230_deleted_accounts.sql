-- Preserve ownership on account deletion; archived media is main-admin only.
SET LOCAL lock_timeout='5s';
GRANT USAGE ON SCHEMA photo_security TO personal_photos_reader;
GRANT EXECUTE ON FUNCTION photo_security.flag(text),photo_security.username() TO personal_photos_reader;
CREATE TABLE public.deleted_accounts (
 name text PRIMARY KEY, marker uuid NOT NULL UNIQUE, display_name text NOT NULL,
 email text, joined_at timestamptz NOT NULL, deleted_at timestamptz NOT NULL DEFAULT now(),
 deleted_by text NOT NULL
);
ALTER TABLE public.deleted_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deleted_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON public.deleted_accounts TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY admin_read ON public.deleted_accounts FOR SELECT TO personal_photos_app,personal_photos_reader USING(photo_security.flag('main_admin'));
GRANT SELECT ON public.deleted_accounts TO personal_photos_app,personal_photos_reader;
GRANT SELECT,INSERT ON public.deleted_accounts TO personal_photos_maintenance;
ALTER TABLE public.events ADD COLUMN archived_account boolean NOT NULL DEFAULT false;
CREATE INDEX events_archived_accounts ON public.events(owner_username,event_id) WHERE archived_account;
-- Defense in depth for direct table readers as well as permission helper callers.
CREATE POLICY archived_accounts ON public.events AS RESTRICTIVE TO personal_photos_app,personal_photos_reader
 USING(NOT archived_account OR photo_security.flag('main_admin'))
 WITH CHECK(NOT archived_account OR photo_security.flag('main_admin'));
CREATE FUNCTION photo_security.archived_owner(who text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT FROM public.deleted_accounts WHERE name=who)
$$;
REVOKE ALL ON FUNCTION photo_security.archived_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.archived_owner(text) TO personal_photos_app,personal_photos_reader;
CREATE POLICY archived_accounts ON public.folders AS RESTRICTIVE TO personal_photos_app,personal_photos_reader
 USING(photo_security.flag('main_admin') OR NOT photo_security.archived_owner(owner_username));
CREATE OR REPLACE FUNCTION photo_security.read_event(id integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM public.events e WHERE e.event_id=id AND (NOT e.archived_account OR photo_security.flag('main_admin')) AND (
 (photo_security.username() IS NOT NULL AND (photo_security.flag('main_admin') OR e.owner_username=photo_security.username()
 OR (e.visibility='GALLERY' AND photo_security.legacy_collection_access())
 OR EXISTS(SELECT FROM public.album_shares s WHERE s.event_id=e.event_id AND s.username=photo_security.username())))
 OR e.event_id=photo_security.public_event()))
$$;
CREATE OR REPLACE FUNCTION photo_security.readable_events() RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH caller AS MATERIALIZED (
  SELECT photo_security.username() AS username,
         photo_security.flag('main_admin') AS main_admin,
         photo_security.public_event() AS public_event,
         photo_security.legacy_collection_access() AS legacy_access
 )
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND c.main_admin
 UNION
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND NOT c.main_admin AND NOT e.archived_account AND e.owner_username=c.username
 UNION
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND NOT c.main_admin AND NOT e.archived_account AND c.legacy_access AND e.visibility='GALLERY'
 UNION
 SELECT e.event_id FROM public.album_shares s JOIN public.events e USING(event_id) CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND NOT c.main_admin AND NOT e.archived_account AND s.username=c.username
 UNION
 SELECT e.event_id FROM public.events e CROSS JOIN caller c WHERE NOT e.archived_account AND e.event_id=c.public_event
$$;

CREATE OR REPLACE FUNCTION photo_security.editable_events() RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH caller AS MATERIALIZED (
  SELECT photo_security.username() AS username,
         photo_security.flag('can_write') AS can_write,
         photo_security.flag('main_admin') AS main_admin
 )
 SELECT e.event_id FROM public.events e CROSS JOIN caller c WHERE c.can_write AND c.main_admin
 UNION ALL
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.can_write AND NOT c.main_admin AND NOT e.archived_account AND e.owner_username=c.username
$$;

CREATE OR REPLACE FUNCTION photo_security.edit_event(id integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT photo_security.flag('can_write') AND EXISTS(SELECT FROM public.events e WHERE e.event_id=id AND
 (photo_security.flag('main_admin') OR (NOT e.archived_account AND e.owner_username=photo_security.username())))
$$;
CREATE OR REPLACE FUNCTION photo_security.public_event() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT l.event_id FROM public.album_public_links l JOIN public.events e USING(event_id)
 WHERE NOT e.archived_account AND l.token_hash=nullif(current_setting('photos.public_hash',true),'')
 AND l.revoked_at IS NULL AND l.expires_at>statement_timestamp() AND l.owner_username=e.owner_username
$$;
-- An identity name cannot be reused to regain archived ownership (including legacy names).
CREATE FUNCTION photo_security.prevent_archived_identity_reuse() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.kind='user' AND EXISTS(SELECT FROM public.deleted_accounts WHERE name=NEW.name)
 THEN RAISE EXCEPTION 'Deleted account identity cannot be reused' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prevent_archived_identity_reuse BEFORE INSERT OR UPDATE OF name ON public.gallery_access_objects
 FOR EACH ROW EXECUTE FUNCTION photo_security.prevent_archived_identity_reuse();
REVOKE ALL ON FUNCTION photo_security.prevent_archived_identity_reuse() FROM PUBLIC;
