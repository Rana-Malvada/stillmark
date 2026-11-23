# Photo AI descriptions

## Current behavior

[ai-categorize.ts](../lib/ai-categorize.ts) defines the current model
`claude-sonnet-4-6` and prompt version `v3-sonnet46-recognition`. Descriptions cover
visible subjects, actions, readable text and confidently recognizable landmarks;
face identities come from the separate People pipeline. Source is authoritative
when the model or prompt changes.

The configured transport is Cortex REST, avoiding a SQL warehouse query for each
inference. The SQL fallback remains in code; it is not the configured production
path. AI inference still has provider costs. Image preparation and model admission
are separate limits; increasing model concurrency does not require preparing the
same number of images simultaneously.

## Choosing the provider

`PHOTO_AI_PROVIDER` lists who describes new photos, first choice first, separated by
commas. Production sets it to `openai`: OpenAI is asked first and Cortex takes over
whenever OpenAI cannot take a request. Cortex is always the last resort, whether or not
it is listed, and removing the setting returns every new description to Cortex. The
list form exists so another provider can be placed ahead of these later without
changing how fallback works.

| Provider | Sends the display image to                                  | Billed by             |
| -------- | ----------------------------------------------------------- | --------------------- |
| `cortex` | Snowflake Cortex (Claude Sonnet 4.6)                        | Snowflake, in credits |
| `openai` | OpenAI's API directly ([sender](../lib/ai/openai-photo.ts)) | OpenAI, in dollars    |

`PHOTO_AI_OPENAI_MODEL` picks the OpenAI model (default `gpt-6.2-astra`); only models
with a recorded price are accepted. Each description stores the instructions and model
that wrote it in `photos.ai_prompt_version` (`v4-openai-<model>`), so descriptions from
different providers can always be told apart.

**Instructions.** OpenAI receives the same instructions as Claude plus one rule: name
the most likely place when the scene strongly suggests one, say "likely" when that is
an inference, and do not guess otherwise. On 20 of the owner's photos compared on
2026-11-23, OpenAI's models followed "do not invent locations" strictly and omitted
nine places Claude had named; with the added rule the default model named all nine.
Claude's instructions are unchanged. The owner chose this model and rule after seeing
the side-by-side results; volume is a few hundred photos a month, so quality was
preferred over the lower-priced model.

**Fallback.** If OpenAI refuses a request before doing any work, that photo is
described through Cortex immediately. For a missing key, a rejected key or no credit
left, OpenAI is also not asked again for thirty minutes; for a request it would not
accept (one image, or a retired model name), only that photo moves. Descriptions
therefore never stop when a credit runs out. A server failure or a "slow down" response
does not switch provider: the photo follows the normal retry path, because the request
may have been charged.

**What it requires.** An outbound rule for `api.openai.com` and the Snowflake secret
`OPENAI_API` holding a key created for this application alone, so it can be withdrawn
without affecting anything else. Both are described in the
[forward change](../migrations/snowflake/202611230900_openai_photo_descriptions.sql),
which no release applies and which needs the owner's approval.

**What it changes for privacy.** OpenAI becomes a processor of members' display images
for new photos. The request asks OpenAI not to store the exchange (`store: false`);
what OpenAI retains beyond that is governed by its API terms, not by this application.

**Cost.** These requests are recorded in the same ledger with the tokens each response
reports and a dollar estimate at OpenAI list prices. They are shown as their own line,
in dollars, and are never converted to Snowflake credits or reconciled against
Snowflake usage. A plan credit that pays for them is not deducted from the estimate.

Search interpretation, video analysis and the search indexes are unaffected: they stay
on Snowflake.

## Hourly allowances

Admission counts claims per clock hour (UTC), in total and per album owner.
Retries, abandoned attempts and same-file reuse all count. Every owner uses
`PHOTO_AI_TENANT_MAX_CLAIMS_PER_HOUR`.

Members have no separate description allowance: their uploads are bounded by the
[total upload allowance](CUSTOMER-ACCOUNTS.md), so every admitted photo is described
without an extra delay.

Reaching an allowance never rejects an upload or discards a photo. The remaining
photos stay queued and are described in later hours.

## Notification and recovery

After a photo is committed, PostgreSQL notifies `stillmark_photo_ai_ready`.
The elected background coordinator opens a dedicated LISTEN connection, registers
it before draining the durable queue, and drains again when notified. The
coordinator retries failed listener connections on renewal. A one-minute recovery
timer handles delayed retries, expired claims and missed notifications.

Notifications are a wake-up signal, not the queue. Claims, retries and results are
stored in PostgreSQL. Closing the upload page does not cancel accepted AI work.
The app must have background jobs enabled and an eligible coordinator; upload-only
processes do not run this scheduler. See [instrumentation](../instrumentation.ts),
[listener](../lib/photos/photo-ai-listener.ts) and [queue](../lib/photos/photo-ai-queue.ts).

## Versions and retries

`photos.ai_prompt_version` records the producing prompt. Identical-file reuse is
version-aware. Legacy completed descriptions without a version remain legacy;
changing a prompt does not automatically regenerate every old description.
Never clear descriptions or claims to force retries without diagnosing the state.
Provider errors, retry timing and unknown inference outcomes have dedicated
recovery paths; replaying a paid request blindly can duplicate costs.

Sync Search publishes catalog content; Update Search performs its separate
enrichment/replay pipeline. Neither command is a blanket AI-description refresh.
See [search operations](operations/search-update.md).

## Validation

The native database gate includes notification/restart recovery and AI admission
checks. The regular suite covers prompt, reuse, inference recovery and retry logic.
Live acceptance additionally requires a real upload, commit-to-claim timing and
provider completion. Code inspection alone does not establish latency or idle
traffic savings. Video AI is separate from photo AI and playback preparation.
