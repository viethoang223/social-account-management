BEGIN;
ALTER TABLE extension_commands DROP CONSTRAINT extension_commands_action_check;
ALTER TABLE extension_commands ADD CONSTRAINT extension_commands_action_check
  CHECK (action IN ('prepare', 'commit', 'comment-prepare', 'comment-commit', 'publication-verify'));
COMMIT;
