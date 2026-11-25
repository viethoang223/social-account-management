CREATE TABLE extension_bindings (
  target_id uuid PRIMARY KEY REFERENCES target_accounts(id) ON DELETE CASCADE,
  uid text NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE,
  installation_id uuid
);

CREATE TABLE extension_commands (
  id uuid PRIMARY KEY,
  target_id uuid NOT NULL REFERENCES target_accounts(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL,
  session_id uuid NOT NULL,
  fencing_token bigint NOT NULL,
  action text NOT NULL CHECK (action IN ('prepare', 'commit')),
  caption text NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  claimed_at timestamptz(3),
  authorized_at timestamptz(3),
  result jsonb,
  UNIQUE (session_id, action)
);

CREATE INDEX extension_commands_target_id_expires_at_idx ON extension_commands(target_id, expires_at);
CREATE UNIQUE INDEX extension_target_uid_unique ON target_accounts(external_id) WHERE connector = 'fb-extension';

INSERT INTO connector_releases (id, connector, version, active, notes)
VALUES (gen_random_uuid(), 'fb-extension', '1.0.0', true, 'Chrome extension, text only, private audience');
