-- EXECUTE on refresh_travel_summary is insufficient without schema USAGE.
-- Preserve the function's existing SECURITY DEFINER boundary: no table grants,
-- schema CREATE, role membership or broader permissions are added.
GRANT USAGE ON SCHEMA photo_security TO personal_photos_search_worker;
