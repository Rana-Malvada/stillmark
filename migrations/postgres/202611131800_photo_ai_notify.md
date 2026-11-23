# Wake photo AI after publication

## Compatibility

Apply the migration before releasing the listener. Older workers continue polling.
The trigger sends an empty notification when the upload publishes a ready photo.
The elected coordinator holds one direct Postgres session, subscribes, then checks
for pending photos. It repeats that sequence after a disconnect. A one-minute
recovery check also picks up eligible retries and expired claims.

## Verification

Run `npm run test:database-gate`. The notification check uses local Postgres,
commits photos during a listener outage, terminates a connected listener, and
compares upload metadata transaction times with the trigger enabled and disabled.

## Rollback

The previous worker can run with the trigger installed. To remove the trigger
after rolling back the worker, use a forward migration that drops
`notify_ready_photo_ai` on `public.photos` before dropping
`public.notify_ready_photo_ai()`. Pending photos remain in the existing table.
