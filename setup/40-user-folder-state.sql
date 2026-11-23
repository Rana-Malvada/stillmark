BEGIN;
CREATE TABLE IF NOT EXISTS user_folder_state (
 username text NOT NULL,
 folder_id integer NOT NULL REFERENCES folders(folder_id) ON DELETE CASCADE,
 expanded boolean NOT NULL DEFAULT true,
 PRIMARY KEY(username,folder_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON user_folder_state TO personal_photos_app;
COMMIT;
