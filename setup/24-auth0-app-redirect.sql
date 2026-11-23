-- Account property, not an app deployment setting. Applies to ALL SPCS ingress
-- endpoints in this account. Regular Snowsight login is unchanged.
-- ALTER replaces the entire mapping: preserve existing mappings if reused elsewhere.
ALTER ACCOUNT SET LOGIN_IDP_REDIRECT = (SPCS = PERSONAL_PHOTOS_AUTH0);
SHOW PARAMETERS LIKE 'LOGIN_IDP_REDIRECT' IN ACCOUNT;
-- Rollback for this account's previously empty mapping:
-- ALTER ACCOUNT UNSET LOGIN_IDP_REDIRECT;
