# Photo AI ready queue lookup

## Compatibility

Both worker versions can use this partial index. It keeps videos, completed photos,
exhausted attempts and incomplete uploads out of the scheduled photo eligibility
lookup. The query compares retry and lease timestamps at read time. The upload
transaction maintains the index as part of saving the photo.

## Verification

Run `npm run test:ai-admission-postgres`. This includes a mostly idle catalog with
6,000 ineligible rows, and checks the plan for the empty queue and the visibility
of a newly committed photo from another connection.

## Rollback

The previous app works with the index present. The transactional build briefly
requires a lock conflicting with writes and has a five-second statement timeout.
If it times out, the migration rolls back and can be retried during a quiet period.
