# Customer upload defaults

Adds administrator-only functions to read and update the upload-count and byte
allowances assigned at registration. Existing customer accounts, signup switches,
issuer configuration and paid-search allowances are unchanged. Writes validate
bounds and record the old/new defaults in the permission audit under the acting
administrator's marker. No direct table grants are added.

Apply through the normal backup/restore migration process. Validated by the customer
account database tests, including member denial and unchanged existing budgets.
