DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM runner_registrations WHERE id = 'local') THEN
    RAISE EXCEPTION 'Runner registration "local" conflicts with the controller runner ID';
  END IF;
END;
$$;

-- The default allows older controllers to insert local agents after rollback.
ALTER TABLE agents ADD COLUMN runner_id text NOT NULL DEFAULT 'local';

-- Decode the old URI components once, retaining the locator for older code.
CREATE FUNCTION pg_temp.decode_agent_locator_component(component text) RETURNS text
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

WITH legacy AS (
  SELECT id, regexp_match(cwd,
    '^runner://([a-zA-Z0-9_.!~*''()+-]|%[0-9a-fA-F]{2})+/([a-zA-Z0-9_.!~*''()+@-]|%[0-9a-fA-F]{2})+$'
  ) AS matches, cwd
  FROM agents
), decoded AS (
  SELECT id,
    pg_temp.decode_agent_locator_component(split_part(cwd, '/', 3)) AS runner,
    pg_temp.decode_agent_locator_component(split_part(cwd, '/', 4)) AS workspace
  FROM legacy WHERE matches IS NOT NULL
)
UPDATE agents SET runner_id = decoded.runner
FROM decoded
WHERE agents.id = decoded.id AND decoded.runner IS NOT NULL
  AND decoded.workspace IS NOT NULL;

DROP FUNCTION pg_temp.decode_agent_locator_component(text);
