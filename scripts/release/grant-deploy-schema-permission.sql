-- User-authorized project deployment permission, applied October 29, 2026.
-- Run with the authorized administrator connection. Does not deploy or restart.
-- Existing runtime-role inheritance and artifact ownership are documented in
-- docs/SNOWFLAKE-AUTOMATION.md; this adds only the previously missing privilege.
GRANT CREATE APPLICATION SERVICE ON SCHEMA PERSONAL_MEDIA.APP
  TO ROLE STILLMARK_DEPLOY_AUTOMATION;
