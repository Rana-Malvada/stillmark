-- One-time administrator setup for unattended operations on existing test objects.
-- No production objects, account-wide privileges, or ownership changes.
-- MODIFY permits isolated PgBouncer/server setting changes; it also permits other
-- instance configuration changes. It does not grant ownership or production access.
GRANT OPERATE, MODIFY ON POSTGRES INSTANCE STILLMARK_LOADTEST_BASELINE_PG
  TO ROLE STILLMARK_TEST_AUTOMATION;
GRANT MODIFY PROGRAMMATIC AUTHENTICATION METHODS
  ON USER STILLMARK_LOADTEST_BASELINE_GATEWAY_USER
  TO ROLE STILLMARK_TEST_AUTOMATION;
GRANT MODIFY PROGRAMMATIC AUTHENTICATION METHODS
  ON USER STILLMARK_LOADTEST_BASELINE_U1
  TO ROLE STILLMARK_TEST_AUTOMATION;
