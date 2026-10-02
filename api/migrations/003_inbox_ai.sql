-- ============================================================================
-- 003 -- The inbox read by a local model
-- ============================================================================
-- A notification's text is read by one local language model (the optional
-- `ai` container, services/inbox/extract.js) after POST /api/inbox has
-- already answered: the phone never waits for it. Each item says where the
-- reading stands, and every person may tell the model how their banks write
-- their name, so that a movement between two parties who are both them is
-- recognised as a transfer.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The reading of each item
-- ----------------------------------------------------------------------------
--   pending  waiting for the model (the API re-queues these when it starts)
--   done     the model answered; the proposals are its answer, validated
--   failed   the model could not be reached or answered nonsense: the item
--            is still there, with its text, to be filled in by hand
--   off      nothing to read: no model configured, or the sender sent a
--            draft of its own
ALTER TABLE inbox_items
    ADD COLUMN extraction text NOT NULL DEFAULT 'off'
        CHECK (extraction IN ('pending', 'done', 'failed', 'off')),
    ADD COLUMN extracted_at timestamptz,
    -- The currency the notification's amount was in, as the model read it.
    -- Nothing is converted: when it is not the wallet's, the interface says
    -- so and the person decides.
    ADD COLUMN currency varchar(10);

COMMENT ON COLUMN inbox_items.extraction IS
    'Where the reading of raw_text by the local model stands: pending, done, failed or off.';

-- What the API looks for when it starts: items still waiting for the model.
CREATE INDEX idx_inbox_items_extraction_pending ON inbox_items (wallet_id)
    WHERE extraction = 'pending';

-- ----------------------------------------------------------------------------
-- The user's own names, as banks write them
-- ----------------------------------------------------------------------------
-- "Marco Todaro", "TODARO MARCO": a personal setting on an identity table (no
-- RLS, api/auth/ only), given to the model with every notification this
-- person's token sends.
ALTER TABLE users
    ADD COLUMN bank_names text[] NOT NULL DEFAULT '{}'
        CHECK (cardinality(bank_names) <= 5);

COMMENT ON COLUMN users.bank_names IS
    'How this person''s banks write their name: tells the notification reader a transfer to oneself from a payment.';
