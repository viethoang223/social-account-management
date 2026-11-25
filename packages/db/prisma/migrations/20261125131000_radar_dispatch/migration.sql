CREATE TABLE extension_radar_scans (
  id uuid PRIMARY KEY,
  target_id uuid NOT NULL REFERENCES target_accounts(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  url text NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'COMPLETE', 'FAILED')),
  lease_token bigint,
  radar_id uuid,
  created_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL
);

CREATE INDEX extension_radar_scans_target_id_state_expires_at_idx ON extension_radar_scans(target_id, state, expires_at);
