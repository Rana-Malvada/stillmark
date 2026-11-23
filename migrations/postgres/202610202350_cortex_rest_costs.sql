CREATE TABLE public.cost_rest_requests (
 id uuid PRIMARY KEY,
 work_id uuid NOT NULL REFERENCES public.cost_work(id),
 model text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reported','unavailable')),
 provider_request_id text,
 usage jsonb,
 estimated_credits numeric,
 pricing_version text NOT NULL,
 CHECK(estimated_credits IS NULL OR estimated_credits>=0)
);
CREATE INDEX cost_rest_requests_time ON public.cost_rest_requests(created_at);
ALTER TABLE public.cost_rest_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_rest_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.cost_rest_requests FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON public.cost_rest_requests TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.cost_rest_requests TO personal_photos_maintenance USING(true) WITH CHECK(true);
