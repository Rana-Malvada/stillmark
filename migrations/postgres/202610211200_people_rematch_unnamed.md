# Reconcile automatic unnamed groups with confirmed people

The initial scan matches at most 100 faces before clustering. Previously, clustering
assigned the rest to unnamed people and made them ineligible for the queued match
pass. Both scan and background matching now include automatic and suggested
assignments to visible unnamed groups. Confirmed assignments and all named or
hidden assignments remain protected.

Grouped candidates compare only against named confirmed references so their own
unnamed group cannot win or suppress the named match. Moving them requires the
existing automatic threshold (at least .75), three independent reference photos,
and a .12 margin over the next named person. Weak or ambiguous candidates remain
in their existing groups. Unassigned-face behavior is unchanged. Ignores, owner
isolation, rejected identities, and model boundaries remain enforced. The conflict
update rechecks the existing assignment so a concurrent confirmation is protected.

Compatible with the current worker and app; no service restart or new image is
needed. Apply with scripts/release/migrations.py apply (includes a backup restore
drill). The migration queues enabled owners with existing machine-assigned unnamed
faces. The existing bounded maintenance consumer processes them without rescanning
photos. Empty groups are retained; existing listing logic determines visibility.

Verification: tests/people-rematching.test.ts covers the 105-face scan/group race,
protected assignments, weak matches and later improved references, plus existing
owner/threshold/reference tests. Run people-worker and people-corrections tests too.
Check face_match_queue and face_match_requests for backlog progress and inspect
assignment status counts. Do not interpret similarity scores as probabilities.

Recovery: forward-fix the functions in a new migration; reverting the function
will not undo completed automatic matches. Existing correction controls remain
available. No automatic matches become confirmed or new named references.
