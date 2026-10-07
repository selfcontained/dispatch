-- A file's type is recorded once, when it is stored, from its bytes (see
-- `detectFileType`), and every reader goes by that: the files API, block
-- attachments and the route that serves the file. Before this, nothing was
-- recorded and each reader guessed again from the name.
--
-- Rows already stored were accepted by their extension, so the extension is
-- the type they were uploaded as; this names it once so the column can be
-- required. Every row written from here on is typed from its bytes.

ALTER TABLE files ADD COLUMN mime_type text;

UPDATE files SET mime_type = CASE
  WHEN file_name ~* '\.png$' THEN 'image/png'
  WHEN file_name ~* '\.jpe?g$' THEN 'image/jpeg'
  WHEN file_name ~* '\.gif$' THEN 'image/gif'
  WHEN file_name ~* '\.webp$' THEN 'image/webp'
  WHEN file_name ~* '\.mp4$' THEN 'video/mp4'
  WHEN file_name ~* '\.pdf$' THEN 'application/pdf'
  WHEN file_name ~* '\.json$' THEN 'application/json'
  WHEN file_name ~* '\.xml$' THEN 'application/xml'
  WHEN file_name ~* '\.html$' THEN 'text/html'
  WHEN file_name ~* '\.css$' THEN 'text/css'
  WHEN file_name ~* '\.(js|jsx|mjs)$' THEN 'text/javascript'
  WHEN file_name ~* '\.csv$' THEN 'text/csv'
  WHEN file_name ~* '\.md$' THEN 'text/markdown'
  WHEN file_name ~* '\.ya?ml$' THEN 'text/yaml'
  ELSE 'text/plain'
END;

ALTER TABLE files ALTER COLUMN mime_type SET NOT NULL;
