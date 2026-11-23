# Email alerts

## Configuration

The gateway's existing five-minute schedule uses the `EmailAlerts` Durable Object
for persistent incident state. The SMTP host is part of the deployment profile. The
mailbox login, sender and recipient are Cloudflare Worker secrets
(`ALERT_SMTP_USERNAME`, `ALERT_FROM`, `ALERT_TO`), so no personal address is committed;
set each with `wrangler secret put`. Store the credential only in the
Cloudflare `ICLOUD_SMTP_PASSWORD` secret. For iCloud use an app-specific password,
not the account password; STARTTLS is mandatory before authentication.

Keep current delivery status and validation receipts in ignored `.release/`.
A historical successful send does not prove the current credential works.

## Monitoring behavior

- Gallery liveness checks the authenticated origin; it does not prove every media file or user login works.
- Gateway credential expiry warns when unavailable or near expiration.
- Signed `/api/health/monitor` requests check aggregate database readiness, database size, recent failed uploads and stalled background work. Public proxy access to that endpoint is denied.
- Credential-event delivery and independent Auth0 log polling retain retry work durably; see [customer account recovery](CUSTOMER-ACCOUNTS.md).
- Three consecutive failures trigger a problem notice; two successes trigger recovery after a delivered problem notice.
- Incident state survives deployment. An unchanged incident does not produce repeated email. Failed sends are retried at most hourly; an ambiguous SMTP acknowledgment can produce a duplicate.

## Stalled background work

Counting failures does not notice work that never finishes: a queue nobody is
claiming, a claim whose worker died, a worker that never started, or a coordinator
that stopped scheduling. The monitor response therefore carries `workHealth`, a
set of counts and ages in seconds read by
[postgres-health.ts](../lib/database/postgres-health.ts), and the gateway judges
them in [work-health.mjs](../cloudflare-gateway/work-health.mjs), where every
threshold below is a named constant.

For uploads, video preparation, face scanning, photo descriptions and search
enrichment the application reports:

- the age of the oldest item that could be claimed now. Items waiting for a retry
  time, items that used up their attempts, and items no active worker run has
  admitted are not counted;
- how many claims are live and how many have an expired lease, with the age of the
  oldest expired one;
- for work done by a launched worker run, how long the run has been starting, or
  how long ago the running worker last reported in. For photo descriptions this is
  the time since the last admitted claim.

It also reports the age of the background coordinator's last lease renewal.

| Incident                   | Opens when, on three consecutive checks                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background coordinator     | The lease was last renewed more than 3 minutes ago (it renews every 10 seconds).                                                                     |
| Stalled upload processing  | A runnable upload has waited more than 15 minutes with no live claim, or a claim expired more than 10 minutes ago.                                   |
| Stalled video preparation  | See the worker-run rules below.                                                                                                                      |
| Stalled face scanning      | See the worker-run rules below.                                                                                                                      |
| Stalled photo descriptions | A runnable photo has waited more than 75 minutes with no live claim and no claim admitted in that time, or a claim expired more than 75 minutes ago. |
| Stalled search enrichment  | See the worker-run rules below; claims are not reported for search.                                                                                  |

Worker-run rules (video, faces, search): the run has been starting for more than
35 minutes; or the running worker has not reported in for more than 10 minutes; or
a claim in the run expired more than 15 minutes ago; or a runnable item has waited
more than 30 minutes with no live claim, no run still starting and no report from
the worker in that time.

These allowances cover normal behaviour. The upload service suspends after fifteen
idle minutes and takes several minutes to resume, and an upload retry backs off for
at most five minutes. GPU and face jobs start from a cold pool; the application
itself stops a run that has not started within thirty minutes and settles one that
has been silent for two to three minutes, so the worker-run incidents open only when
that recovery is not happening either. Photo descriptions are admitted per clock
hour, so runnable photos wait up to an hour once an allowance is used. A long queue
that a worker is draining, a warm idle worker and an empty queue are all healthy.

**Alert interval.** The check runs every five minutes and an incident opens on the
third consecutive failing check, so the problem email is sent at most 15 minutes
after a signal passes its threshold: within 18 minutes of the coordinator stopping,
within 30 minutes of an upload becoming runnable with no worker, within 25 minutes
of a running video, face or search worker going silent, and within 90 minutes for
photo descriptions. Recovery is sent after two consecutive healthy checks. The
email contains counts and ages only; no file, album or account is named.

Limits of these signals:

- A signal the application cannot read is left out, and a missing signal is
  unknown: it neither opens nor recovers an incident, and never changes the
  database-readiness result. Each read is limited to 1.5 seconds and counts stop
  at 1000.
- Work that the application has already given up on is not a stall: a run it
  stopped and marked as needing attention, items that exhausted their attempts, and
  queued items waiting for an administrator to start a run. Review those in Admin.
- A worker that keeps renewing its claims but makes no progress is not detected.
- Search enrichment reports queue age only for runs started automatically; a run
  started by hand is judged by its startup time and heartbeat. Video AI analysis
  and search publication are covered only through the coordinator incident.
- An incident already open when its threshold or name changes stays open until
  two healthy checks.

## New-account notices

When customer accounts are enabled, the same five-minute check sends one email
to the alert recipient for each self-registered account, containing its display
name and creation time. The email address, login identity and username of the new
member are not sent; review them in Admin. The signed monitor response lists
accounts registered in the last 48 hours and the Durable Object remembers which
it has reported, so a notice normally arrives within five minutes and is not
repeated.

- Accounts that existed before the first check with this feature are not reported.
- At most three notices are sent per check; a burst is delivered over later checks.
- A failed send is retried on the next check. An ambiguous SMTP acknowledgment can
  produce a duplicate. If email delivery is unavailable for more than 48 hours,
  accounts created at the start of the outage are not reported.
- Notices do not change incident state, and a notice failure does not raise an alert.

See the [migration note](../migrations/postgres/202611220300_signup_notifications.md).

Storage thresholds apply to database bytes, excluding WAL, other databases and
filesystem overhead. Review the configured threshold when resizing. A recovered
upload-failure rate does not mean failed files were repaired. Unavailable downstream
metrics remain unknown instead of reporting false recovery.

## Delivery verification and recovery

Run gateway tests for monitoring transitions, transport failure, deduplication and
SMTP handling. An authorized delivery check must use the configured recipient,
clearly identify itself as a test, and avoid changing real incident state or
inducing a production outage. Keep any temporary endpoint authenticated and
short-lived, then remove it and its secret and verify restoration.

Record SMTP acceptance after DATA separately from inbox receipt. `535` means
authentication failed: verify the configured login and app-specific credential;
do not claim the message was sent. A `250` acceptance does not guarantee inbox
placement. Repair credentials through the account owner's authentication flow,
then recheck delivery. Never log passwords or message recipient details in public
telemetry. Cloudflare or SMTP-provider outages can prevent email delivery.
