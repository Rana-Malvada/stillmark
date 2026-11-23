# Remembered sign-in revocation retention

Apply before releasing the gateway's optional 30-day sessions. This extends the
expiry of newly created logout revocations to 30 days plus five minutes, so a
copied remembered cookie cannot become valid again after logout. Existing
short-lived sessions and revocations remain unchanged. No privileges change.
Keep this migration if rolling back the gateway; longer retention is safe.

The gateway preserves a fixed expiry from sign-in, rather than extending the
30-day period on each request. Unchecked sign-ins retain the one-hour idle and
12-hour absolute limits. Existing account/password revocation checks still apply.
