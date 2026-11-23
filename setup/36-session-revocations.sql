BEGIN;
CREATE TABLE IF NOT EXISTS gallery_revoked_sessions (
 sid uuid PRIMARY KEY,
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '12 hours 5 minutes')
);
CREATE INDEX IF NOT EXISTS gallery_revoked_sessions_expiry ON gallery_revoked_sessions(expires_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON gallery_revoked_sessions TO personal_photos_app;
COMMIT;
