ALTER TABLE extension_commands ADD COLUMN comment jsonb;
ALTER TABLE extension_commands DROP CONSTRAINT extension_commands_action_check;
ALTER TABLE extension_commands ADD CONSTRAINT extension_commands_action_check
  CHECK (action IN ('prepare', 'commit', 'comment-prepare', 'comment-commit'));

ALTER TABLE publication_comments ADD COLUMN persona_approval_id uuid REFERENCES persona_approvals(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE publications ADD COLUMN comment_access_confirmed_at timestamptz(3);
ALTER TABLE extension_radar_scans ADD COLUMN kind text NOT NULL DEFAULT 'RADAR',
  ADD COLUMN "limit" integer, ADD COLUMN result jsonb,
  ADD CONSTRAINT extension_scan_kind_check CHECK (kind IN ('RADAR', 'RESEARCH_PROFILE', 'RESEARCH_POST'));
