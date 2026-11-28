-- Runner-initiated enrollment ("dispatch-runner connect"). The runner
-- generates its keypair and submits only the public key before any human
-- approval; the one-time code is shown to the operator by the runner and
-- typed into the authenticated Dispatch API, never sent by the runner. The
-- client certificate issued on approval is bound to this stored public key,
-- so a code observed in transit cannot redeem a different key.
CREATE TABLE runner_connect_requests (
  id text PRIMARY KEY,
  public_key_pem text NOT NULL,
  code_hash text NOT NULL,
  code_expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  denied_at timestamptz,
  registration_id text REFERENCES runner_registrations (id),
  -- Not a secret on its own (the private key never leaves the runner); kept
  -- so a repeated poll (retry, slow network) returns the same certificate
  -- idempotently. Reachable only through the request id, a bearer-strength
  -- token the runner alone holds.
  issued_cert text
);

CREATE INDEX runner_connect_requests_expires_idx
  ON runner_connect_requests (code_expires_at);
