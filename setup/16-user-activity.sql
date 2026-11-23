-- PostgreSQL only. Run before deploying user activity tracking.
CREATE TABLE IF NOT EXISTS user_activity_sessions (
 session_id uuid PRIMARY KEY, username text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_activity_sessions_seen ON user_activity_sessions(last_seen);
CREATE TABLE IF NOT EXISTS user_activity_events (
 event_id uuid PRIMARY KEY, username text NOT NULL,
 session_id uuid, occurred_at timestamptz NOT NULL DEFAULT now(),
 kind text NOT NULL, target text NOT NULL DEFAULT '', source text NOT NULL CHECK(source IN ('browser','server'))
);
CREATE INDEX IF NOT EXISTS user_activity_events_time ON user_activity_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS user_activity_events_user_time ON user_activity_events(username,occurred_at DESC);
CREATE INDEX IF NOT EXISTS user_activity_events_kind_time ON user_activity_events(kind,occurred_at DESC);
CREATE TABLE IF NOT EXISTS user_activity_maintenance (id integer PRIMARY KEY CHECK(id=1), cleaned_at timestamptz NOT NULL);
