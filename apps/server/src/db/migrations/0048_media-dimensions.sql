-- Natural pixel dimensions of an image media row, filled in at upload time by
-- reading the file's header. Nullable, and stays null for non-images and for
-- any file whose header could not be parsed — the chat feed falls back to a
-- fixed-height box for those, which is exactly how every image rendered
-- before this column existed.
ALTER TABLE media ADD COLUMN IF NOT EXISTS width INTEGER;
ALTER TABLE media ADD COLUMN IF NOT EXISTS height INTEGER;
