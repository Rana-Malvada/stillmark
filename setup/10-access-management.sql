-- App-owned registry and durable intent/audit log. Snowflake remains the authority for grants.
BEGIN;
CREATE TABLE IF NOT EXISTS gallery_access_objects (
 kind TEXT NOT NULL CHECK (kind IN ('user','role')),
 name TEXT NOT NULL,
 marker UUID NOT NULL UNIQUE,
 profile TEXT CHECK (profile IN ('viewer','admin','admin_readonly')),
 display_name TEXT NOT NULL,
 email TEXT,
 created_by TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(kind,name)
);
CREATE TABLE IF NOT EXISTS gallery_access_operations (
 id UUID PRIMARY KEY,
 actor TEXT NOT NULL,
 request JSONB NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('running','succeeded','failed')),
 result JSONB,
 error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gallery_access_operations_recent ON gallery_access_operations(created_at DESC);
COMMIT;
