ALTER TABLE publication_comments
  ALTER COLUMN source_comment_id DROP NOT NULL,
  ADD COLUMN source_post_id uuid REFERENCES source_posts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT publication_comments_one_origin_check
    CHECK (num_nonnulls(source_comment_id, source_post_id) = 1);

CREATE INDEX publication_comments_source_post_id_destination_id_idx
  ON publication_comments(source_post_id, destination_id);
