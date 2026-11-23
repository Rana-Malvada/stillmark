SET LOCAL lock_timeout='5s';
ALTER TABLE search_batch_runs ADD COLUMN settled_at timestamptz;
ALTER TABLE search_batch_runs ADD COLUMN continued_by uuid REFERENCES search_batch_runs(id);
ALTER TABLE search_batch_runs ADD COLUMN pipeline_error text;
