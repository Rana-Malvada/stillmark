# Reuse idle face and playback workers

Apply after automatic media admission and before the new app and worker images.
The two existing run tables gain an idle timestamp and an admission flag. The
worker's idle check and application admission serialize on that run's row lock.
New work clears the idle timestamp; fifteen minutes with no queued or running
work closes admission. Active media is never stopped by this idle check. Existing
finite job deadlines, worker concurrency and explicit cancellation remain intact.

The function runs as its caller, with only existing table permissions. It grants
no new access to media. Old images ignore the columns and finish as before. Keep
the additive migration when rolling application/worker images back.

Validate concurrent admission versus idle expiry, reset after new work, no expiry
while a claim is running, opt-in/skips, cancellation, and same-run reuse. Face
organization must complete before idle waiting so new faces become visible promptly.

Playback runs also have one original three-hour cycle deadline and a unique
continuation link. Only a runtime/claim-budget stop with durable completed output
and untouched queued items may continue; the child preserves that deadline.
Failed, cancelled, no-progress and expired cycles do not loop. This bounds
automatic recovery without resetting the existing per-job runtime limits.
