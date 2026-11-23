SET LOCAL lock_timeout='5s';
CREATE TABLE public.upload_chunk_writes (
 upload_id uuid NOT NULL REFERENCES public.upload_sessions(upload_id) ON DELETE CASCADE,
 chunk_index integer NOT NULL CHECK(chunk_index>=0 AND chunk_index<512),
 owner text NOT NULL,
 token uuid NOT NULL,
 hash text NOT NULL,
 byte_size integer NOT NULL CHECK(byte_size>0),
 lease_until timestamptz NOT NULL,
 PRIMARY KEY(upload_id,chunk_index)
);
ALTER TABLE public.upload_chunk_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_chunk_writes FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.upload_chunk_writes TO personal_photos_app,personal_photos_maintenance;
CREATE POLICY app ON public.upload_chunk_writes TO personal_photos_app
 USING(owner=photo_security.username())
 WITH CHECK(owner=photo_security.username() AND photo_security.flag('can_write'));
CREATE POLICY maintenance ON public.upload_chunk_writes TO personal_photos_maintenance USING(true) WITH CHECK(true);
