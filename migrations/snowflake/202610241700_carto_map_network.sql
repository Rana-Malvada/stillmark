-- Apply with the deployment administrator, without a warehouse.
-- Preserve existing place-name lookup access and allow only CARTO's tile host.
-- PERSONAL_PHOTOS_TRAVEL_EAI already references this rule and is declared in app.yml.
-- Snowflake derives the browser CSP from the service's external access integrations;
-- the application's own response CSP cannot override a stricter proxy policy.
ALTER NETWORK RULE PERSONAL_MEDIA.APP.TRAVEL_PLACE_EGRESS
 SET VALUE_LIST=('nominatim.openstreetmap.org:443','basemaps.cartocdn.com:443');

-- Refresh the service's generated proxy policy after the rule changes.
-- Keep this list aligned with app.yml; do not remove the other integrations.
ALTER APPLICATION SERVICE PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_APP
 SET EXTERNAL_ACCESS_INTEGRATIONS=(PERSONAL_PHOTOS_EAI,PERSONAL_PHOTOS_AUTH0_EAI,PERSONAL_PHOTOS_TRAVEL_EAI);
