-- Merge-risk recommendations: one record per (pull request, head, review
-- state). Diagnostics only; no prompt text, evidence, or credentials.
CREATE TABLE merge_risk_decision_daily (
  day date PRIMARY KEY,
  calls integer NOT NULL DEFAULT 0
);
CREATE TABLE merge_risk_decision_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  url text NOT NULL,
  head_sha text NOT NULL,
  review_fingerprint text NOT NULL,
  status text NOT NULL,
  prompt_version text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}',
  UNIQUE(url, head_sha, review_fingerprint)
);
CREATE INDEX merge_risk_decision_records_created ON merge_risk_decision_records(created_at DESC);
CREATE INDEX merge_risk_decision_records_url ON merge_risk_decision_records(url, head_sha, created_at DESC);
