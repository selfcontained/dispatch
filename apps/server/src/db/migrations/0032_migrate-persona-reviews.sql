-- Migrate legacy persona review records into the unified review model.
-- Legacy tables remain intact as a rollback/reference safety net, but new
-- persona review activity writes only to reviews/review_feedback_items/
-- review_thread_messages.

DO $$
DECLARE
  legacy_review RECORD;
  legacy_feedback RECORD;
  migrated_review_id INTEGER;
  migrated_item_id INTEGER;
  total_items INTEGER;
  resolved_items INTEGER;
  migrated_status TEXT;
  migrated_resolution TEXT;
  feedback_body TEXT;
BEGIN
  FOR legacy_review IN
    SELECT pr.*
    FROM persona_reviews pr
    WHERE NOT EXISTS (
      SELECT 1
      FROM reviews r
      WHERE r.reviewer_type = 'agent'
        AND r.reviewer_agent_id = pr.agent_id
    )
    ORDER BY pr.id
  LOOP
    SELECT COUNT(*)::int,
           COUNT(*) FILTER (
             WHERE status NOT IN ('open', 'forwarded')
           )::int
      INTO total_items, resolved_items
      FROM agent_feedback
      WHERE agent_id = legacy_review.agent_id;

    migrated_status := CASE
      WHEN total_items = 0 OR resolved_items = total_items THEN 'resolved'
      WHEN resolved_items > 0 THEN 'partially_resolved'
      ELSE 'open'
    END;

    INSERT INTO reviews (
      agent_id,
      assigned_agent_id,
      reviewer_type,
      reviewer_agent_id,
      summary,
      status,
      created_at,
      updated_at
    ) VALUES (
      legacy_review.parent_agent_id,
      legacy_review.parent_agent_id,
      'agent',
      legacy_review.agent_id,
      COALESCE(
        NULLIF(BTRIM(legacy_review.summary), ''),
        'Legacy persona review by ' || legacy_review.persona
      ),
      migrated_status,
      legacy_review.created_at,
      legacy_review.updated_at
    )
    RETURNING id INTO migrated_review_id;

    FOR legacy_feedback IN
      SELECT *
      FROM agent_feedback
      WHERE agent_id = legacy_review.agent_id
      ORDER BY id
    LOOP
      migrated_resolution := CASE legacy_feedback.status
        WHEN 'fixed' THEN 'fixed'
        WHEN 'ignored' THEN 'dismissed'
        WHEN 'dismissed' THEN 'dismissed'
        ELSE NULL
      END;

      INSERT INTO review_feedback_items (
        review_id,
        file_path,
        line_start,
        line_end,
        status,
        resolution,
        resolution_note,
        resolved_by,
        resolved_at,
        created_at,
        updated_at
      ) VALUES (
        migrated_review_id,
        legacy_feedback.file_path,
        legacy_feedback.line_number,
        NULL,
        CASE WHEN migrated_resolution IS NULL THEN 'open' ELSE 'resolved' END,
        migrated_resolution,
        legacy_feedback.resolution_reason,
        CASE WHEN migrated_resolution IS NULL THEN NULL ELSE legacy_review.parent_agent_id END,
        legacy_feedback.resolved_at,
        legacy_feedback.created_at,
        COALESCE(legacy_feedback.resolved_at, legacy_feedback.created_at)
      )
      RETURNING id INTO migrated_item_id;

      feedback_body := legacy_feedback.description;
      IF legacy_feedback.suggestion IS NOT NULL
         AND BTRIM(legacy_feedback.suggestion) <> '' THEN
        feedback_body := feedback_body || E'\n\nSuggestion: ' || legacy_feedback.suggestion;
      END IF;

      INSERT INTO review_thread_messages (
        feedback_item_id,
        author_type,
        author_agent_id,
        type,
        content,
        created_at
      ) VALUES (
        migrated_item_id,
        'agent',
        legacy_review.agent_id,
        'text',
        jsonb_build_object('body', feedback_body),
        legacy_feedback.created_at
      );

      IF migrated_resolution IS NOT NULL THEN
        INSERT INTO review_thread_messages (
          feedback_item_id,
          author_type,
          author_agent_id,
          type,
          content,
          created_at
        ) VALUES (
          migrated_item_id,
          'agent',
          legacy_review.parent_agent_id,
          'resolution',
          jsonb_build_object(
            'body', COALESCE(legacy_feedback.resolution_reason, ''),
            'resolution', migrated_resolution
          ),
          COALESCE(legacy_feedback.resolved_at, legacy_feedback.created_at)
        );
      END IF;
    END LOOP;
  END LOOP;
END $$;

UPDATE agents
SET role = 'review'
WHERE role = 'standard'
  AND id IN (
    SELECT reviewer_agent_id
    FROM reviews
    WHERE reviewer_type = 'agent' AND reviewer_agent_id IS NOT NULL
  );
