# Recover interrupted worker launches

Apply before the application release. Adds durable launch backoff to existing face
and video run records. Existing table privileges and row policies remain unchanged.
Old application/worker versions ignore the added columns; keep the migration on
rollback. No queue entries, creation timestamps, worker images or budgets change.

Maintenance retries only missing deterministic jobs before their original
30-minute startup deadline. The launch advisory lock serializes startup and cancel.
An existing pending job is inspected, never replaced. Validate commit-before-start,
lost START response, cancellation, deadline expiry and concurrent maintenance.
