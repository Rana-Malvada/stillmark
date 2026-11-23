SET LOCAL lock_timeout='5s';
ALTER TABLE public.automatic_work_state
 ADD COLUMN retry_attempts integer NOT NULL DEFAULT 0,
 ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.face_scan_runs
 ADD COLUMN organization_pending boolean NOT NULL DEFAULT false,
 ADD COLUMN cycle_deadline timestamptz NOT NULL DEFAULT (now()+interval '3 hours'),
 ADD COLUMN continued_from uuid UNIQUE REFERENCES public.face_scan_runs(id),
 ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.video_preparation_runs
 ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0;
