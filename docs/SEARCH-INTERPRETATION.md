# Natural-language search interpretation

Ordinary scene descriptions use PostgreSQL full-text and Snowflake Cortex Search.
Sentence length and an empty result do not trigger model interpretation. Names, conjunctions,
recognized calendar expressions, explicit GPS circles and simple person exclusions
are resolved locally. Unresolved OR/NOT/comparison logic use structured interpretation; unattended
replay never initiates a paid interpretation. Unsupported logic returns clarification
rather than silently dropping a requirement.

The interpreter uses claude-sonnet-4-6 through Snowflake’s direct Cortex Messages API. The acceptance corpus exposed repeated scope and comparison errors with Haiku; Sonnet is used for correctness on interpreted queries. Its configured estimated token rates are three times Haiku's; simple searches still make no interpretation call. It returns schema-constrained node plans, decoded into bounded Boolean expressions over a registered metadata contract. The decoder rejects unused nodes, cycles, invalid references and excessive depth. People, places, periods, literal metadata, and descriptive evidence retain their AND/OR/NOT relationships. Album photo scopes distinguish an album with a qualifying photo from one with no qualifying photo.

It cannot supply SQL or photo IDs. Names are resolved under current row security.
Same-full-name identities remain separate records but act as alternatives within a
search group. First names include all visible matching people; different required
names must occur on the same photo. Explicitly selected People remain mandatory.

The current face predicate accepts settled `auto` and `confirmed` assignments,
excludes `suggested` assignments and ignores faces marked ignored. This is not a
manual-confirmation-only predicate. No face assignments are changed by search.
A negative person filter means no settled assignment, not proof that an unrecognized
person is absent. Printed portraits remain valid person evidence.

Exact person/calendar/GPS/metadata results use keyset pagination without the semantic candidate cap. Album-only queries include empty albums. Validated plans are reused for subsequent pages. Scene retrieval remains bounded (normally 1,000 candidates per
Cortex request); it is ranked retrieval, not exhaustive semantic recall. Exact days
require an actual photo date. Broader month/year filters may use album dates when
photo dates are absent. Calendar comparisons and supported ranges run locally.
Named destinations use recorded photo location fields with album fallback when photo place text is absent. Explicit coordinates specify an actual GPS radius. Named mountain-range matching is limited to recorded destinations and does not classify arbitrary coordinates.

Photo descriptions, captions, tags, OCR, album and location metadata contribute to
retrieval. Precise race/plate queries require supporting photo text, tags or OCR;
album names cannot establish a visible number. Unknown identifiers are not claimed
as exact matches, which can omit a valid photo whose metadata is incomplete.

Sessions cache candidates, validated plans and caller-scoped ranking documents.
Catalog changes invalidate candidates; recent validated interpretation can be reused
with fresh name resolution. Every page is rehydrated under current permissions.
Related-results mode has a separate cache key and retains all original constraints.

Uniformly weak semantic results with no lexical support show “No strong matches,”
with an explicit option to view related photos. Missing scores alone never suppress
results. The score threshold is conservative calibration against the private dataset,
not a universal confidence probability; rerun evaluation after scorer changes.

Optional visual ordering only corroborates text/semantic candidates and is bypassed
for precise identifiers and documents. Optional batch ordering preserves exact evidence
and a clearly separated leading relevance group before blending ranks. Old ranking
formats are not applied. Both optional features remain gated by deployment flags.

The UI reports request latency and interpretation token usage. Search interpretation
uses the search_ai cost category. New calls record direct Messages token usage and available rate-based estimates. Historical Agents usage retains its separate reconciliation path.
The quality/ranking guards do not add warehouse queries or LLM calls. Interpretation remains an explicit paid call, attributed separately from retrieval. Use `npm run test:search-acceptance` for the opt-in acceptance corpus; keep live-test measurements and remaining semantic coverage in `.release/`. Tests cover a finite corpus, not every possible query.
