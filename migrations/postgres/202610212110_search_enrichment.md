# Admin search enrichment

Additive OCR/vector outbox and bounded batch-run tables. The worker role starts
NOLOGIN and must be provisioned with its own secret. It has no photo, face or user
table access: only queued original paths, private saved-search candidate evidence,
and bounded publication columns. App reads of OCR/vector evidence use photo RLS.
Photo replacement resets enrichment; publication is fenced by revision and lease.
OCR publication refreshes existing keyword/outbox triggers. No job starts on upload.
Old runtime remains compatible. Apply after the saved-search migration.
