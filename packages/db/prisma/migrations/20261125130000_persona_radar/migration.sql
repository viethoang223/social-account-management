CREATE TABLE persona_directories (
  id text PRIMARY KEY,
  registry jsonb NOT NULL
);

INSERT INTO persona_directories (id, registry)
VALUES ('main', '{"schema":"desk.personas/1","registryId":"seedingsys","revision":0,"profiles":[],"relations":[]}');

CREATE TABLE customer_radars (
  id uuid PRIMARY KEY,
  url text NOT NULL UNIQUE,
  name text NOT NULL,
  analyzed_at timestamptz(3) NOT NULL,
  report jsonb NOT NULL
);

CREATE TABLE persona_approvals (
  id uuid PRIMARY KEY,
  fingerprint text NOT NULL UNIQUE,
  context jsonb NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz(3) NOT NULL
);

CREATE INDEX persona_approvals_approved_at_idx ON persona_approvals(approved_at);
