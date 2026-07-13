-- The review-feedback system has two terminal states only.
ALTER TABLE review_feedback_items
  DROP CONSTRAINT IF EXISTS review_feedback_items_resolution_check;

UPDATE review_feedback_items
SET resolution = 'dismissed'
WHERE resolution IN ('ignored', 'wont_fix');

ALTER TABLE review_feedback_items
  ADD CONSTRAINT review_feedback_items_resolution_check
  CHECK (resolution IS NULL OR resolution IN ('fixed', 'dismissed'));
