-- Normalize legacy pins and give each usable entry a unique stable ID.
UPDATE agents
SET pins = CASE
  WHEN jsonb_typeof(pins) <> 'array' THEN '[]'::jsonb
  ELSE COALESCE((
    SELECT jsonb_agg(
      pin || jsonb_build_object(
        'id',
        CASE WHEN existing_id <> '' AND id_count = 1 THEN existing_id
             ELSE 'pin_' || md5(agents.id || ordinal::text || jsonb_extract_path_text(pin, 'label') || jsonb_extract_path_text(pin, 'value')) END
      ) ORDER BY ordinal
    )
    FROM (
      SELECT pin, ordinal, COALESCE(jsonb_extract_path_text(pin, 'id'), '') AS existing_id,
             COUNT(*) OVER (PARTITION BY COALESCE(jsonb_extract_path_text(pin, 'id'), '')) AS id_count
      FROM jsonb_array_elements(pins) WITH ORDINALITY AS items(pin, ordinal)
      WHERE jsonb_typeof(pin) = 'object'
        AND COALESCE(jsonb_extract_path_text(pin, 'label'), '') <> ''
        AND COALESCE(jsonb_extract_path_text(pin, 'value'), '') <> ''
        AND jsonb_extract_path_text(pin, 'type') IN ('string', 'url', 'port', 'code', 'pr', 'filename', 'markdown')
    ) AS valid_pins
  ), '[]'::jsonb)
END;
