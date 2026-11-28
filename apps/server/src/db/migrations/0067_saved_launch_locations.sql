-- Keep the old directory and run config columns for rollback.
ALTER TABLE templates ADD COLUMN location jsonb;
ALTER TABLE jobs ADD COLUMN location jsonb;
ALTER TABLE job_runs ADD COLUMN location jsonb;

UPDATE templates SET location = jsonb_build_object('runner', 'local', 'path', directory);
UPDATE jobs SET location = jsonb_build_object('runner', 'local', 'path', directory);
UPDATE job_runs SET location = jsonb_build_object('runner', 'local', 'path', config->>'directory')
WHERE config->>'directory' IS NOT NULL;

-- A saved project on an enrolled runner has no directory before preparation.
-- Names share a namespace on that runner. Local rows retain main's folder scope.
ALTER TABLE templates DROP CONSTRAINT templates_directory_name_key;
CREATE UNIQUE INDEX templates_directory_name_key ON templates
  ((COALESCE(location->>'runner', 'local')), directory, name);
DROP INDEX jobs_directory_name_key;
CREATE UNIQUE INDEX jobs_directory_name_key ON jobs
  ((COALESCE(location->>'runner', 'local')), directory, name);

-- A rolled-back controller can edit a directory without writing its location.
-- Clear the old encoding so the next controller decodes the edited directory.
CREATE FUNCTION invalidate_legacy_saved_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.directory IS DISTINCT FROM OLD.directory AND
     NEW.location IS NOT DISTINCT FROM OLD.location THEN
    NEW.location := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER templates_legacy_location_update BEFORE UPDATE OF directory ON templates
FOR EACH ROW EXECUTE FUNCTION invalidate_legacy_saved_location();
CREATE TRIGGER jobs_legacy_location_update BEFORE UPDATE OF directory ON jobs
FOR EACH ROW EXECUTE FUNCTION invalidate_legacy_saved_location();
