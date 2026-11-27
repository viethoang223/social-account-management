CREATE TABLE parent_accounts (
    slot integer PRIMARY KEY CHECK (slot > 0),
    uid text UNIQUE CHECK (uid ~ '^[0-9]{1,32}$')
);

INSERT INTO parent_accounts (slot)
SELECT slot FROM generate_series(21, 40) AS slots(slot);
