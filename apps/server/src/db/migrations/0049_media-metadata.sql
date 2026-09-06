-- Per-type metadata for a media row.
--
-- `media` holds screenshots, video, PDFs and text in one table, so an attribute
-- that only means something for some of them does not earn a column of its own.
-- Image dimensions land here as `width`/`height`; video duration, PDF page
-- counts and the like can join them without another migration.
--
-- NOT NULL DEFAULT '{}' rather than nullable: it removes the null-vs-empty
-- distinction from every read site, and rows written before this column existed
-- come out as `{}`, which is exactly the "nothing known about this file" state
-- consumers already fall back on.
ALTER TABLE media
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
