# Maintenance access to assertion cleanup

Grants schema USAGE to the existing maintenance role so its explicitly granted
cleanup function can be called. This does not grant table access, schema CREATE,
or function EXECUTE beyond existing grants. Function execution requires schema
USAGE as well as the function grant; verification must use the actual role grants
without pre-granting access in the fixture.

Compatible with the running and preceding app versions. Verification: call
photo_security.cleanup_gateway_assertions() as personal_photos_maintenance;
verify the app role still cannot execute it. A rollback of this grant disables
cleanup but does not permit replay or change user authorization.
