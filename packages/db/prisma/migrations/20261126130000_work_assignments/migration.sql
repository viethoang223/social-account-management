CREATE TYPE "WorkAssignmentStatus" AS ENUM ('PENDING', 'DONE', 'CANCELLED');

CREATE TABLE work_assignments (
    id uuid PRIMARY KEY,
    code text NOT NULL CHECK (code IN ('X1', 'X2', 'X3', 'X4', 'Y1', 'Y2')),
    status "WorkAssignmentStatus" NOT NULL DEFAULT 'PENDING',
    source_id uuid REFERENCES sources(id) ON DELETE SET NULL ON UPDATE CASCADE,
    source_post_id uuid REFERENCES source_posts(id) ON DELETE SET NULL ON UPDATE CASCADE,
    from_assignment_id uuid REFERENCES work_assignments(id) ON DELETE SET NULL ON UPDATE CASCADE,
    urls text[] NOT NULL DEFAULT '{}',
    brief text NOT NULL DEFAULT '',
    results text[] NOT NULL DEFAULT '{}',
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL
);

CREATE INDEX work_assignments_created_at_id_idx ON work_assignments(created_at, id);
CREATE INDEX work_assignments_code_status_created_at_idx ON work_assignments(code, status, created_at);

CREATE TABLE work_assignment_targets (
    assignment_id uuid NOT NULL REFERENCES work_assignments(id) ON DELETE CASCADE ON UPDATE CASCADE,
    target_id uuid NOT NULL REFERENCES target_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY (assignment_id, target_id)
);

CREATE INDEX work_assignment_targets_target_id_idx ON work_assignment_targets(target_id);
