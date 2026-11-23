-- Persistent, cross-instance upload-start limits; no passwords or file data.
CREATE TABLE IF NOT EXISTS upload_start_limits (
 owner text PRIMARY KEY,
 window_start timestamptz NOT NULL DEFAULT now(),
 starts integer NOT NULL CHECK (starts > 0)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON upload_start_limits TO personal_photos_app;
