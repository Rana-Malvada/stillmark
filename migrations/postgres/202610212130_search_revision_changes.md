# Invalidate saved searches only on real changes

Zero-row background updates can advance the global search revision even without
a changed photo. Replace statement triggers with row triggers,
and ignore bookkeeping-only differences. Changed OCR still changes search_vector
through the existing photo trigger and correctly invalidates saved rankings.

Compatible with old/new runtimes. Verify zero-row updates and identical updates leave
the revision unchanged, while changed names/permissions/captions advance it. Uses the
existing locked-down trigger function and grants; no new rights or compute.
