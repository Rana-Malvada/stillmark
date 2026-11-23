BEGIN;
CREATE TABLE IF NOT EXISTS cost_work (
 id uuid PRIMARY KEY, category text NOT NULL CHECK(category IN ('ai','search_indexing','warehouse')),
 owners jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_work_time ON cost_work(created_at);
CREATE TABLE IF NOT EXISTS cost_index_weights (
 work_id uuid NOT NULL REFERENCES cost_work(id) ON DELETE CASCADE,
 service text NOT NULL, username text NOT NULL, units bigint NOT NULL CHECK(units>0),
 PRIMARY KEY(work_id,service,username)
);
ALTER TABLE cost_index_weights ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'merge';
GRANT SELECT,INSERT,UPDATE,DELETE ON cost_work,cost_index_weights TO personal_photos_app;
COMMIT;
