-- Private bounded evidence, deliberately separate from display/metrics records.
CREATE TABLE merge_risk_evidence_snapshots (
  assessment_id bigint PRIMARY KEY REFERENCES merge_risk_decision_records(id) ON DELETE CASCADE,
  owner_ids text[] NOT NULL,
  owner_projects jsonb NOT NULL,
  review_digest text NOT NULL,
  evidence jsonb NOT NULL CHECK (octet_length(evidence::text) <= 16384)
);
CREATE TABLE merge_risk_explanations (
  assessment_id bigint PRIMARY KEY REFERENCES merge_risk_decision_records(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'
);
