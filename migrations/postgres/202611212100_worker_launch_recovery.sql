SET LOCAL lock_timeout='5s';
-- Durable backoff survives coordinator restarts. Existing run creation times remain
-- the startup deadline; retries never create a new run or extend its budget.
ALTER TABLE public.face_scan_runs
 ADD COLUMN launch_attempts integer NOT NULL DEFAULT 0 CHECK (launch_attempts>=0),
 ADD COLUMN next_launch_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.video_preparation_runs
 ADD COLUMN launch_attempts integer NOT NULL DEFAULT 0 CHECK (launch_attempts>=0),
 ADD COLUMN next_launch_at timestamptz NOT NULL DEFAULT now();
