SET LOCAL lock_timeout='5s';
CREATE INDEX search_session_expiration ON search_sessions(expires_at,id);
CREATE INDEX search_session_viewer_recency ON search_sessions(username,last_used_at DESC,id DESC);
