-- Build-only downloads for pinned ffmpeg-static releases. Run as ACCOUNTADMIN.
-- The running app does not use this integration. No credentials are required.
CREATE NETWORK RULE IF NOT EXISTS PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_BUILD_GITHUB
 MODE = EGRESS
 TYPE = HOST_PORT
 VALUE_LIST = ('github.com:443','release-assets.githubusercontent.com:443')
 COMMENT = 'Personal Photos build: FFmpeg release downloads and GitHub release redirects';
CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS PERSONAL_PHOTOS_BUILD_EAI
 ALLOWED_NETWORK_RULES = (PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_BUILD_GITHUB)
 ALLOWED_AUTHENTICATION_SECRETS = ()
 ENABLED = TRUE
 COMMENT = 'Build-only FFmpeg downloads; referenced by app.yml build_eai';
-- ACCOUNTADMIN owns this integration and performs the build. No grant to runtime/public roles.
DESCRIBE INTEGRATION PERSONAL_PHOTOS_BUILD_EAI;
DESCRIBE NETWORK RULE PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_BUILD_GITHUB;
