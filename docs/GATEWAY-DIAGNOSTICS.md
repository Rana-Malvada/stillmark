# Gateway diagnostics

Deployed October 4, 2026. Dataset `personal_photos_gateway_metrics`, binding
`GATEWAY_METRICS`; set `GATEWAY_DIAGNOSTICS` to `disabled` and redeploy to stop writes.
Native Worker invocation logging stays disabled because it can contain URLs.

The gateway samples 1% of requests, with a ceiling of 60 records per minute per
Worker isolate. This is not a global account cap. Sampling is approximate and the
ceiling can undercount busy isolates. Use Cloudflare's native request totals for
exact totals rather than multiplying this dataset into a billing count.

Only fixed route categories, allowlisted methods, status, time to response headers,
authorization timing, and whether a Range header was present are stored. No URLs,
query values, identifiers, cookies, credentials, error messages, or bodies are
stored. Timing does not measure download throughput or whole-video transfer time.
The asynchronous analytics sink does not consume or copy the response body.

## Schema

| Field   | Meaning                                               |
| ------- | ----------------------------------------------------- |
| index1  | `gateway-v1`                                          |
| blob1   | Schema version `v1`                                   |
| blob2   | Fixed route category                                  |
| blob3   | Allowlisted HTTP method                               |
| double1 | Response status (500 if the handler throws)           |
| double2 | Time to response headers, milliseconds                |
| double3 | Sampling probability, 0.01                            |
| double4 | Media authorization milliseconds, -1 when unavailable |
| double5 | Range request, 0 or 1                                 |

## Read example

Use Cloudflare's Analytics Engine SQL API with an Account Analytics Read credential.
Do not save the credential in this repository. `_sample_interval` accounts for
Cloudflare's own downstream sampling; it does not undo our emergency ceiling.

```sql
SELECT blob2 AS category, double1 AS status,
       SUM(_sample_interval) AS sampled_requests,
       SUM(double2 * _sample_interval) / SUM(_sample_interval) AS avg_header_ms
FROM personal_photos_gateway_metrics
WHERE timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY category, status
ORDER BY sampled_requests DESC
```

Cloudflare documents three-month retention. Workers Free includes 100,000 writes
and 10,000 reads per day. These are separate from Worker and Durable Object request
limits. Check current vendor pricing before changing sample rates or plans.

Deployment confirmed the dataset binding. Stored rows verified in the authenticated Analytics Engine Studio on October 4, 2026.
A read-only query returned 8 records (LIMIT 10), latest timestamp 17:54:02 UTC,
with gateway-v1/v1, fixed other_api/thumbnail/page/static categories, GET, status 200,
header timing, 0.01 sample rate, and media authorization timing. The deployment
OAuth credential still lacks Analytics Read, but Studio provided direct retained-row verification.
