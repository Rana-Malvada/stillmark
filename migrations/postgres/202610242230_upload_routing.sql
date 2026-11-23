SET LOCAL lock_timeout='5s';
CREATE TABLE public.upload_routing (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 enabled boolean NOT NULL DEFAULT false,
 desired text NOT NULL CHECK(desired IN ('app','pool')),
 route text NOT NULL CHECK(route IN ('app','pool')),
 phase text NOT NULL CHECK(phase IN ('app','pool','draining','resuming','suspending','error')),
 error text,
 requested_by text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Existing production uploads use the pool. No compute is changed by this migration.
INSERT INTO public.upload_routing(id,desired,route,phase) VALUES(true,'pool','pool','pool');
CREATE TABLE public.upload_pool_requests (
 id uuid PRIMARY KEY,
 owner text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.upload_routing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_routing FORCE ROW LEVEL SECURITY;
ALTER TABLE public.upload_pool_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_pool_requests FORCE ROW LEVEL SECURITY;
GRANT SELECT ON public.upload_routing TO personal_photos_app;
CREATE POLICY app_read ON public.upload_routing FOR SELECT TO personal_photos_app
 USING(photo_security.username() IS NOT NULL);
GRANT SELECT,INSERT,DELETE ON public.upload_pool_requests TO personal_photos_app;
CREATE POLICY app ON public.upload_pool_requests TO personal_photos_app
 USING(owner=photo_security.username()) WITH CHECK(owner=photo_security.username() AND photo_security.flag('can_write'));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.upload_routing,public.upload_pool_requests TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.upload_routing TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintenance ON public.upload_pool_requests TO personal_photos_maintenance USING(true) WITH CHECK(true);
