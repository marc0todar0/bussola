-- ============================================================================
-- 007 -- The inbox: readings retried, and notifications sent once
-- ============================================================================
-- Two things a phone and a hosted model do to the inbox, and what the inbox
-- does about them.
--
-- A hosted model fails for a while and then answers again: a quota for the
-- minute (429), a server error, a timeout. Until now one failed reading left
-- the item 'failed' for good, to be filled in by hand. From here a failure of
-- that kind keeps the item 'pending' and tries again later (services/inbox/
-- retry.js: after 1 min, 5 min, 30 min and 2 h, five readings in all); only
-- after the last one, or at once for a failure that waiting cannot mend (a
-- refused key, a model that does not exist, an answer that is not JSON), does
-- it become 'failed'. The schedule lives on the row, so a restart loses
-- nothing.
--
-- A phone that sent a notification and did not hear back sends it again. The
-- sender may name each notification with an id of its own (client_id); the
-- same id twice in one wallet is the same notification, and the second POST
-- stores nothing (inbox_controller.createItem).
-- ============================================================================

ALTER TABLE inbox_items
    -- Readings tried so far that did not succeed.
    ADD COLUMN attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    -- For a pending item: not to be read before this moment. Set by a
    -- transient failure (the backoff) and by the reader that claims a due
    -- item (a lease: if that process dies, the item comes due again). NULL
    -- for an item just received, which its receiver reads at once.
    ADD COLUMN next_attempt_at timestamptz,
    -- The sender's own id for this notification, so that sending it twice
    -- stores it once. Kept when the item is resolved and its text cleared: a
    -- late retry of an accepted notification must not bring it back.
    ADD COLUMN client_id text CHECK (client_id IS NULL OR length(client_id) BETWEEN 1 AND 100);

COMMENT ON COLUMN inbox_items.attempts IS
    'Readings of raw_text by the model that failed so far; a transient failure is retried until five.';
COMMENT ON COLUMN inbox_items.next_attempt_at IS
    'For a pending reading: when it may be tried (again). NULL = just received, its receiver reads it.';
COMMENT ON COLUMN inbox_items.client_id IS
    'The sender''s id for this notification: unique per wallet, so a retried POST stores nothing new.';

-- One notification per sender id and wallet. The arbiter of createItem's
-- INSERT ... ON CONFLICT DO NOTHING, which is what makes two identical POSTs
-- racing each other store one row. Per wallet: the same id in another wallet
-- is somebody else's notification, and never conflicts with it.
CREATE UNIQUE INDEX uq_inbox_items_wallet_client ON inbox_items (wallet_id, client_id)
    WHERE client_id IS NOT NULL;

-- What the scheduler looks for every half minute, wallet by wallet: pending
-- readings that have come due. It replaces 003's index on the same rows.
DROP INDEX idx_inbox_items_extraction_pending;
CREATE INDEX idx_inbox_items_extraction_due ON inbox_items (wallet_id, next_attempt_at)
    WHERE extraction = 'pending';
