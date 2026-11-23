-- These identity functions return at most one row. PostgreSQL otherwise assumes
-- 1,000 rows per set-returning function; the lateral join becomes an estimated
-- million-row plan and can trigger expensive JIT compilation per request.
ALTER FUNCTION photo_security.app_permission_snapshot(uuid) ROWS 1;
ALTER FUNCTION photo_security.native_app_identity(text) ROWS 1;
ALTER FUNCTION photo_security.gateway_app_identity_once(text,uuid,uuid,bigint) ROWS 1;
