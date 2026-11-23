# Cortex REST cost attribution

Apply before the REST photo pipeline is deployed. Additive table; existing app
versions continue working. Requests link to immutable owner weights in cost_work.
Only the maintenance role can read or write; browser users receive scoped totals
through the existing server-side cost endpoints. No images, prompts, credentials,
or signed URLs are recorded.

Each attempt is recorded before inference. Known response token counts are priced
using the versioned consumption-table rate; missing usage remains unavailable,
not zero. Failed parsing still records billed tokens. These are estimates, not
Snowflake metered credits or invoice totals, and are separate from SQL AI totals.

Verify the cortex-photo, cortex-rest-costs and personal-costs tests, plus table
RLS and role grants. Roll back the app while retaining the table for history.

Agents transport uses pricing_version=agents-unverified and stores allowlisted
per-model token counts. Estimated credits stay NULL until Agents billing is
verified; Messages estimates must not be substituted for these charges.
