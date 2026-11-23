-- Keep the old directory and run config columns for rollback.
ALTER TABLE templates ADD COLUMN location jsonb;
ALTER TABLE jobs ADD COLUMN location jsonb;
ALTER TABLE job_runs ADD COLUMN location jsonb;

CREATE FUNCTION pg_temp.decode_saved_locator_component(component text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  decoded text;
BEGIN
  SELECT convert_from(string_agg(
    CASE WHEN left(token[1], 1) = '%'
      THEN decode(substr(token[1], 2), 'hex')
      ELSE convert_to(token[1], 'UTF8')
    END,
    ''::bytea ORDER BY position
  ), 'UTF8')
  INTO decoded
  FROM regexp_matches(component, '%[0-9a-fA-F]{2}|.', 'g')
    WITH ORDINALITY AS tokens(token, position);

  -- The historical decoder measured the length in UTF-16 code units.
  IF char_length(decoded) + char_length(regexp_replace(
    decoded, U&'[^\+010000-\+10FFFF]', '', 'g'
  )) NOT BETWEEN 1 AND 128 OR decoded ~ U&'[\0001-\001F\007F-\009F]' THEN
    RETURN NULL;
  END IF;
  RETURN decoded;
EXCEPTION WHEN invalid_parameter_value OR character_not_in_repertoire THEN
  RETURN NULL;
END;
$$;

CREATE FUNCTION pg_temp.saved_location(directory text, project text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  runner text;
BEGIN
  IF directory ~ '^runner://([a-zA-Z0-9_.!~*''()+-]|%[0-9a-fA-F]{2})+/([a-zA-Z0-9_.!~*''()+@-]|%[0-9a-fA-F]{2})+$' THEN
    runner := pg_temp.decode_saved_locator_component(split_part(directory, '/', 3));
    IF runner IS NOT NULL AND
       pg_temp.decode_saved_locator_component(split_part(directory, '/', 4)) IS NOT NULL THEN
      RETURN jsonb_build_object('runner', runner, 'projectId', project, 'legacy', true);
    END IF;
  END IF;
  RETURN jsonb_build_object('runner', 'local', 'path', directory);
END;
$$;

UPDATE templates SET location = pg_temp.saved_location(directory, project_id);
UPDATE jobs SET location = pg_temp.saved_location(directory,
  (SELECT project_id FROM templates WHERE id = jobs.template_id));
UPDATE job_runs SET location = pg_temp.saved_location(config->>'directory',
  (SELECT t.project_id FROM jobs j JOIN templates t ON t.id = j.template_id
    WHERE j.id = job_runs.job_id))
WHERE config->>'directory' IS NOT NULL;

DROP FUNCTION pg_temp.saved_location(text, text);
DROP FUNCTION pg_temp.decode_saved_locator_component(text);

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
