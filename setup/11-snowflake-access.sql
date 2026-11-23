-- Run once as ACCOUNTADMIN. Access Manager is separate from photo administration.
-- The app uses its existing owner connection for fixed, scoped provisioning commands.
-- No global CREATE USER, MANAGE GRANTS or ACCOUNTADMIN privileges are granted to managers.
CREATE ROLE IF NOT EXISTS PERSONAL_PHOTOS_ACCESS_MANAGER
 COMMENT='Manage Personal Photos gallery accounts through the application';
GRANT USAGE ON DATABASE PERSONAL_MEDIA TO ROLE PERSONAL_PHOTOS_ACCESS_MANAGER;
GRANT USAGE ON SCHEMA PERSONAL_MEDIA.APP TO ROLE PERSONAL_PHOTOS_ACCESS_MANAGER;
GRANT USAGE ON APPLICATION SERVICE PERSONAL_MEDIA.APP.PERSONAL_PHOTOS TO ROLE PERSONAL_PHOTOS_ACCESS_MANAGER;
-- Bootstrap only the existing app owner. Additional managers require an account administrator.
GRANT ROLE PERSONAL_PHOTOS_ACCESS_MANAGER TO USER EXAMPLEADMIN;
