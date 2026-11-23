-- Not applied by any release. Lets the application send photo descriptions to OpenAI
-- directly, with Snowflake Cortex as the fallback (docs/AI-DESCRIPTIONS.md).
-- Target: account EX00000 (EXAMPLEORG-EXAMPLEACCT), database PERSONAL_MEDIA. The integration
-- requires ACCOUNTADMIN; apply only after the owner approves it.
--
-- Prerequisite, done by the owner and never recorded in this repository: the generic
-- secret PERSONAL_MEDIA.APP.OPENAI_API, holding an OpenAI key created for this
-- application alone.
--
-- Effect: the application service may open connections to api.openai.com:443 and to
-- no other new host, and only this one secret may travel with that integration.
-- Snowflake derives the service's proxy content policy from its integrations, so this
-- host is also added there; the application's own stricter response policy still applies.
USE ROLE ACCOUNTADMIN;
CREATE NETWORK RULE IF NOT EXISTS PERSONAL_MEDIA.APP.OPENAI_EGRESS
 MODE=EGRESS TYPE=HOST_PORT VALUE_LIST=('api.openai.com:443');
CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS PERSONAL_PHOTOS_OPENAI_EAI
 ALLOWED_NETWORK_RULES=(PERSONAL_MEDIA.APP.OPENAI_EGRESS)
 ALLOWED_AUTHENTICATION_SECRETS=(PERSONAL_MEDIA.APP.OPENAI_API)
 ENABLED=TRUE;
GRANT USAGE ON INTEGRATION PERSONAL_PHOTOS_OPENAI_EAI TO ROLE PERSONAL_PHOTOS_RUNTIME;
GRANT READ ON SECRET PERSONAL_MEDIA.APP.OPENAI_API TO ROLE PERSONAL_PHOTOS_RUNTIME;

-- Verify:
--   DESCRIBE NETWORK RULE PERSONAL_MEDIA.APP.OPENAI_EGRESS;      -- one host, port 443
--   SHOW GRANTS ON SECRET PERSONAL_MEDIA.APP.OPENAI_API;         -- READ to the runtime role only
-- app.yml declares the integration, the secret (as OPENAI_API) and
-- PHOTO_AI_PROVIDER=openai; a release after this change switches it on.
--
-- Recovery: remove PHOTO_AI_PROVIDER from config/templates/app.yml and release; every
-- new description returns to Cortex. To withdraw access entirely, also remove the
-- integration and secret from app.yml, release, then:
--   DROP EXTERNAL ACCESS INTEGRATION PERSONAL_PHOTOS_OPENAI_EAI;
--   DROP NETWORK RULE PERSONAL_MEDIA.APP.OPENAI_EGRESS;
--   DROP SECRET PERSONAL_MEDIA.APP.OPENAI_API;
