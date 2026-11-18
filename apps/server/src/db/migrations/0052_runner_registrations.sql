-- Enrolled remote runners. The service authority holds the CA that issues the
-- runner listener certificate and every enrolled runner's client certificate.
-- One-time pairing codes are stored only as SHA-256 hashes.
CREATE TABLE runner_authority (
  id smallint PRIMARY KEY CHECK (id = 1),
  ca_cert text NOT NULL,
  ca_key text NOT NULL,
  server_cert text NOT NULL,
  server_key text NOT NULL,
  server_hosts jsonb NOT NULL DEFAULT '[]'::jsonb,
  port integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runner_registrations (
  id text PRIMARY KEY,
  name text NOT NULL,
  endpoint_host text NOT NULL,
  code_hash text UNIQUE,
  code_expires_at timestamptz,
  cert_fingerprint text UNIQUE,
  cert_expires_at timestamptz,
  workspaces jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  enrolled_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz
);

-- A name addresses placements (runner://<name>/<workspace>), so only one
-- unrevoked registration may hold it.
CREATE UNIQUE INDEX runner_registrations_active_name
  ON runner_registrations (name) WHERE revoked_at IS NULL;
