# Maps

Maps use CARTO Positron raster tiles directly from the browser when the
`CARTO_BASEMAPS` generic-string secret is mounted. The website-restricted key is
intentionally sent to clients, but is never committed or embedded at build time.
For local development set `SNOWFLAKE_SECRET_CARTO_BASEMAPS_SECRET_STRING` in an
ignored `.env.local`. Without the key, installations use the OSM tile proxy.

Both app domains must be allowed in CARTO's website restrictions. Tiles send only
the origin as their referrer. Shared albums request map tiles only when the owner
has enabled location sharing. CARTO tiles are never proxied or cached by the app or
gateway; browser and CDN caching is managed by CARTO. Usage is available in the CARTO
Basemaps dashboard.

## Enabling CARTO

Apply `migrations/snowflake/202610241700_carto_map_network.sql` with the deployment
administrator. This adds the tile host to the travel network rule. Snowflake derives
its browser content security policy from that rule, so mounting the key alone is not
enough. Verify that real tiles render in a signed-in browser after deployment.
