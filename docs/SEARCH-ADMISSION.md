# Search admission and recovery

Interactive photo and album searches have one request deadline covering identity
resolution, queue waiting, retrieval, and result hydration. Cold retrieval and
saved-search replay share a bounded scheduler within each application process.
Cache hits retain live row-security checks and the request deadline.

| Setting                           | Default | Accepted range            |
| --------------------------------- | ------- | ------------------------- |
| `SEARCH_REQUEST_TIMEOUT_MS`       | 30000   | 100–120000                |
| `SEARCH_MAX_ACTIVE`               | 4       | 1–32                      |
| `SEARCH_MAX_ACTIVE_PER_USER`      | 1       | 1–shared active limit     |
| `SEARCH_MAX_QUEUED`               | 32      | 0–256                     |
| `SEARCH_MAX_QUEUED_PER_USER`      | 2       | 0–shared queue limit      |
| `SEARCH_MAX_SUBSCRIBERS`          | 128     | 1–2048                    |
| `SEARCH_MAX_SUBSCRIBERS_PER_USER` | 8       | 1–shared subscriber limit |

Per-user queue/subscriber defaults are reduced when the corresponding shared limit
is lower. Invalid settings fail closed. The existing `SEARCH_PARTITION_CONCURRENCY`
default remains 2, with its existing range of 1–8.

Simultaneous identical cold misses share retrieval and session creation only when
the verified database identity, query options, search kind, allowed scope, scope
revision, and page size agree. Each subscriber retains its own cancellation and
deadline; each response hydrates results under its own request identity. Shared
work carries a copied verified identity and its own signal. It does not inherit
gateway request bindings or another request's mutable authentication caches.

Queue waiting counts against the operation deadline. Exhausted admission returns
HTTP 503 with `Retry-After: 1`; timeout returns HTTP 504 with the same retry hint.
Client disconnect cancels that subscriber. When no subscribers remain, shared work
is canceled. An active slot is retained until the underlying work settles, including
already-started sibling provider calls. This bounds outstanding work even if a
transport is slow to honor cancellation. A hung transport can reduce available
capacity; the application reports overload instead of starting unlimited work.

Eligibility pages are still consumed without truncating the library. At the default
settings, at most four admitted pipelines and two simultaneous semantic partitions
per pipeline run in one process. This is not a fleet-wide quota or a claim about
supported active users. Saved-search replay and interactive requests use the same
local budget; separate replicas have separate budgets. Existing customer AI
allowances still apply. Mixed-load latency and native provider cancellation/recovery
remain tasks for the isolated runtime validation.

No migration or new service is required. Deploy the matching application release
through the existing checks when authorized. Defaults require no manifest changes;
configuration changes should be recorded in the deployment source. Regression tests
cover admission, duplicate misses, scope/identity/revision separation, large-library
recall, deadlines, cancellation, failed-provider draining, and recovery.
