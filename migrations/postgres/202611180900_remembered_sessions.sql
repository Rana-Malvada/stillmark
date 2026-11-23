SET LOCAL lock_timeout='5s';
ALTER TABLE public.gallery_revoked_sessions ALTER COLUMN expires_at SET DEFAULT (now()+interval '30 days 5 minutes');
