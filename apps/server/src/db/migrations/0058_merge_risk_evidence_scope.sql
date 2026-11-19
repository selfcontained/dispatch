-- The empty scope is reserved for historical native assessments.
-- Explanations and evidence snapshots inherit their scope through assessment_id.
ALTER TABLE merge_risk_decision_records
  ADD COLUMN evidence_scope text NOT NULL DEFAULT '',
  ADD COLUMN base_sha text,
  DROP CONSTRAINT merge_risk_decision_records_url_head_sha_review_fingerprint_key,
  ADD UNIQUE (url, head_sha, review_fingerprint, evidence_scope);

DROP INDEX merge_risk_decision_records_url;
CREATE INDEX merge_risk_decision_records_scope_history
  ON merge_risk_decision_records(url, evidence_scope, created_at DESC, id DESC);
