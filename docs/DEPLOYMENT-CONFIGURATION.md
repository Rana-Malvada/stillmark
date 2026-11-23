# Deployment configuration

`config/deployment.json` is the checked-in, non-secret profile for this deployment.
Application code, the gateway, and release tools use this profile. Credentials remain
in Snowflake secrets, Worker secrets, and local credential stores; never add them here.

## Change workflow

1. Review the profile change, including account, domains, roles, stages, warehouse,
   search services, PostgreSQL host, GPU image, and alert addresses.
2. Run `npm run config:render`. This renders `app.yml`, the Wrangler manifest,
   face/video specifications and face/search/video provisioning references from
   `config/templates/`. The authoritative output list is in
   [render-deployment.mjs](../scripts/render-deployment.mjs). Upload worker rendering
   uses its separate settings and renderer.
3. Run `npm run config:check`. The release gate rejects drift between generated
   files and the profile. Edit templates for structural changes; edit the profile
   for environment values. Do not edit generated files alone.
4. For a GPU control change, render `python3 workers/video-gpu/build-control.py`
   to a review file. It uses the current control template and worker specification.
   Compare deployed definitions and grants before applying a forward change.
5. Use the app release process, and deploy the gateway separately with its reviewed
   configuration. Preserve both previous versions for rollback.
6. Verify live login/logout, authorization, media delivery and seeking, upload,
   search, cost refresh, and GPU controls. Test a bounded conversion when worker
   destinations or credentials change. Do not claim a new-account deployment was
   tested simply because alternate-profile unit tests pass.

Rendering verifies repository consistency, not live state. Compare generated
configuration to the deployed definitions before applying it. A successful render
does not establish that a worker image or grant has been deployed.

## Validation and security

The shared loader rejects missing values, SQL identifier punctuation, malformed
origins, account/API mismatches, gateway host mismatches, header injection, and
invalid image paths. SQL object identifiers come only from this trusted profile,
never from HTTP input. The media gateway still permits only the exact configured
storage hostname and HTTPS. Configuration is an operator-controlled trust boundary,
not a runtime user preference.

The profile ships with both app and Worker code. Changing it requires coordinated
releases; it is not a dynamic settings service. Changing the Snowflake account also
requires correct external secrets, permissions, resources, DNS, and Auth0 callbacks.
Those are not created merely by rendering configuration.

## Historical exceptions

Frozen `setup/` files retain their original identifiers. The offline legacy AI
classification SQL intentionally identifies historical queries from the original
account; it is not runtime configuration and must not be rewritten to misclassify
history. Dated investigation documents and test fixtures may retain example values.
A complete fresh-account installer remains separate work.
