-- One application role, not Snowflake ACCOUNTADMIN. No account-level privileges.
CREATE ROLE IF NOT EXISTS PERSONAL_PHOTOS_APP_OWNER COMMENT='Personal Photos full application administration';
GRANT ROLE PERSONAL_PHOTOS_ADMIN TO ROLE PERSONAL_PHOTOS_APP_OWNER;
GRANT ROLE PERSONAL_PHOTOS_ACCESS_MANAGER TO ROLE PERSONAL_PHOTOS_APP_OWNER;
-- No user grants: assign deliberately in Users & Roles after deployment.
