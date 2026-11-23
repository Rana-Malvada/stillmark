-- NULL ownership preserves existing shared collection folders.
ALTER TABLE folders ADD COLUMN IF NOT EXISTS owner_username TEXT;
CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders(owner_username);
