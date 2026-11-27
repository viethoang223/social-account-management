-- Rename content sources in place. Posts, mappings and jobs reference the source UUID.
UPDATE "sources"
SET
    "code" = 'N' || substring("code" FROM 2),
    "name" = CASE
        WHEN "name" = 'Nguồn ' || "code" THEN 'Nguồn N' || substring("code" FROM 2)
        WHEN "name" = "code" THEN 'N' || substring("code" FROM 2)
        ELSE "name"
    END,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "code" ~ '^A[0-9]+$';
