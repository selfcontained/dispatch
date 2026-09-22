-- An agent's launch is one block, its card: the briefing it was given, the
-- steps that brought its workspace up and the instructions it runs with,
-- which used to be three rows (a `launch` post, a `workspace` row and a
-- `system_prompt` row). A review's findings are blocks of their own, each
-- with its record as its state and its discussion as its thread, and the
-- review shows them; where a review stands comes from them alone, so the
-- verdict goes. A review request was a post made of instructions for the
-- agent; the request is a prompt now and never a row.

ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_kind_check;
ALTER TABLE blocks ADD CONSTRAINT blocks_kind_check
  CHECK (kind IN ('text', 'question', 'form', 'file', 'link', 'review',
                  'finding', 'tasks', 'launch'));
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_origin_check;

-- ── Launch cards ─────────────────────────────────────────────────────────

-- The startup and the instructions an agent's old rows recorded.
CREATE TEMP TABLE launch_records AS
SELECT a.id AS agent_id,
       (SELECT w.data->'startup' FROM blocks w
         WHERE w.origin = 'workspace' AND w.author_agent_id = a.id
         ORDER BY w.created_at LIMIT 1) AS startup,
       (SELECT s.text FROM blocks s
         WHERE s.origin = 'system_prompt' AND s.author_agent_id = a.id
         ORDER BY s.created_at LIMIT 1) AS instructions
  FROM agents a;

-- A launch post becomes the card.
UPDATE blocks b
   SET kind = 'launch',
       origin = NULL,
       data = NULL,
       state = jsonb_strip_nulls(jsonb_build_object(
                 'startup', r.startup, 'instructions', to_jsonb(r.instructions)))
  FROM launch_records r
 WHERE b.origin = 'launch' AND b.to_agent_id = r.agent_id;
UPDATE blocks SET kind = 'launch', origin = NULL, data = NULL
 WHERE origin = 'launch';

-- An agent launched with no briefing had no post: its earliest record row
-- becomes the card, in the place the stream already showed it.
WITH first_record AS (
  SELECT DISTINCT ON (author_agent_id) id, author_agent_id AS agent_id
    FROM blocks
   WHERE origin IN ('workspace', 'system_prompt')
     AND NOT EXISTS (
       SELECT 1 FROM blocks l
        WHERE l.kind = 'launch' AND l.to_agent_id = blocks.author_agent_id)
   ORDER BY author_agent_id, created_at, id
)
UPDATE blocks b
   SET kind = 'launch',
       origin = NULL,
       author_kind = 'user',
       author_agent_id = NULL,
       to_agent_id = f.agent_id,
       launched_by_agent_id = a.launched_by_agent_id,
       delivered = true,
       read_at = NULL,
       text = '',
       data = NULL,
       state = jsonb_strip_nulls(jsonb_build_object(
                 'startup', r.startup, 'instructions', to_jsonb(r.instructions)))
  FROM first_record f
  JOIN launch_records r ON r.agent_id = f.agent_id
  LEFT JOIN agents a ON a.id = f.agent_id
 WHERE b.id = f.id;

DELETE FROM blocks
 WHERE origin IN ('workspace', 'system_prompt', 'review_request');

ALTER TABLE blocks ADD CONSTRAINT blocks_origin_check
  CHECK (origin IS NULL OR origin = 'turn');

-- An open ask can sit in a thread now (a child asks in its own): the index
-- behind "what is waiting on a person" covers threads too.
DROP INDEX IF EXISTS blocks_open_input_idx;
CREATE INDEX blocks_open_input_idx
  ON blocks (stream_id, author_agent_id)
  WHERE kind IN ('question', 'form')
    AND to_agent_id IS NULL
    AND (state IS NULL OR (state->'answer' IS NULL AND state->'submission' IS NULL));

-- ── Findings ─────────────────────────────────────────────────────────────

-- Each finding a block in its review's thread, with a stable id so the
-- comments about it can be moved under it.
CREATE TEMP TABLE finding_blocks AS
SELECT r.id AS review_id,
       f.value->>'id' AS finding_key,
       md5(r.id::text || ':' || (f.value->>'id'))::uuid AS id,
       f.value AS finding,
       f.ord
  FROM blocks r
 CROSS JOIN LATERAL jsonb_array_elements(r.data->'findings')
       WITH ORDINALITY AS f(value, ord)
 WHERE r.kind = 'review' AND jsonb_typeof(r.data->'findings') = 'array';

INSERT INTO blocks
  (id, stream_id, author_kind, author_agent_id, to_agent_id, kind,
   thread_id, reply_to, text, data, state, attachments, delivered,
   created_at, updated_at)
SELECT fb.id, r.stream_id, r.author_kind, r.author_agent_id, r.to_agent_id,
       'finding', r.id, r.id, '',
       fb.finding - 'id',
       COALESCE(
         r.state->'findings'->fb.finding_key,
         jsonb_build_object('status', 'open', 'by', jsonb_build_object('kind', 'user'),
                            'at', to_jsonb(r.created_at))),
       '[]'::jsonb,
       CASE WHEN r.to_agent_id IS NULL THEN NULL ELSE true END,
       r.created_at + fb.ord * interval '1 microsecond',
       r.updated_at
  FROM finding_blocks fb
  JOIN blocks r ON r.id = fb.review_id
ON CONFLICT (id) DO NOTHING;

-- A comment about a finding is a reply in the finding's own thread, and so
-- is everything that answers it: an answer to a question asked under a
-- finding never carried the tag, and must not be left behind in the
-- review's thread. A descendant tagged with another finding follows its own.
WITH RECURSIVE moved AS (
  SELECT c.id, fb.id AS finding_id, fb.review_id
    FROM blocks c
    JOIN finding_blocks fb
      ON c.thread_id = fb.review_id AND c.data->>'findingId' = fb.finding_key
  UNION
  SELECT d.id, m.finding_id, m.review_id
    FROM blocks d
    JOIN moved m ON d.reply_to = m.id AND d.thread_id = m.review_id
   WHERE d.data IS NULL OR NOT (d.data ? 'findingId')
)
UPDATE blocks c
   SET thread_id = m.finding_id,
       reply_to = CASE WHEN c.reply_to = m.review_id THEN m.finding_id ELSE c.reply_to END,
       data = NULLIF(c.data - 'findingId', '{}'::jsonb)
  FROM moved m
 WHERE c.id = m.id;

UPDATE blocks SET data = NULLIF(data - 'findingId', '{}'::jsonb)
 WHERE data ? 'findingId';

UPDATE blocks r
   SET data = jsonb_build_object('summary', COALESCE(r.data->'summary', '""'::jsonb)),
       state = jsonb_build_object('blocks', COALESCE(
                 (SELECT jsonb_agg(fb.id ORDER BY fb.ord)
                    FROM finding_blocks fb WHERE fb.review_id = r.id),
                 '[]'::jsonb))
 WHERE r.kind = 'review';

-- Text rows no longer carry these.
UPDATE blocks SET data = NULLIF(data - 'startup' - 'reviewRequest', '{}'::jsonb)
 WHERE kind = 'text' AND (data ? 'startup' OR data ? 'reviewRequest');

DROP TABLE launch_records;
DROP TABLE finding_blocks;
