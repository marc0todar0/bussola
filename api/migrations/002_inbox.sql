-- ============================================================================
-- 002 -- The inbox: personal API tokens, and drafts waiting for a person
-- ============================================================================
-- A bank notification on a phone becomes a *draft* here, sent by an iPhone
-- Shortcuts automation or an Android app with a personal token. Nothing
-- becomes a transaction until somebody confirms it in the interface.
--
-- Two tables, one of each kind:
--
--   * api_tokens is identity, like sessions and passkeys: no Row Level
--     Security, reached only from api/auth/ through db.queryAuth(), every
--     statement naming the user;
--   * inbox_items is data, like transactions: wallet_id from the context, and
--     the same four policies as every other data table.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Personal API tokens
-- ----------------------------------------------------------------------------
-- A token belongs to a person *and* a wallet: it is what lets an automation
-- drop drafts into one wallet without a browser session. It opens nothing but
-- the two inbox endpoints (api/auth/tokens.js), and the membership is checked
-- again on every use -- losing the wallet, or being made read-only there,
-- makes the token useless at once, without anybody having to revoke it.
--
-- Only the sha256 of the token is stored, as for sessions: the token is 32
-- random bytes, not a guessable password, so a KDF would buy nothing.
CREATE TABLE api_tokens (
    id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      int         NOT NULL REFERENCES users (id)   ON DELETE CASCADE,
    wallet_id    int         NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
    label        text        NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
    token_hash   text        NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    -- Revoked tokens are kept (for the record) and never accepted again.
    revoked_at   timestamptz
);

CREATE INDEX idx_api_tokens_user ON api_tokens (user_id);

COMMENT ON TABLE api_tokens IS
    'Personal tokens for apps and automations: they may only post to the inbox of one wallet.';
COMMENT ON COLUMN api_tokens.token_hash IS 'sha256 (hex) of the token, never the token itself.';

-- ----------------------------------------------------------------------------
-- Inbox items
-- ----------------------------------------------------------------------------
-- What arrived, what could be read out of it, and what was decided. The
-- proposals (amount, date, merchant, type, account, category) are only
-- suggestions: accepting one creates the transaction the person confirmed in
-- the form, through the same code as any other.
--
-- raw_text is the notification as it came. It can carry more than the
-- transaction (a card number's last digits, a balance), so it is cleared the
-- moment the item is resolved, accepted or dismissed.
CREATE TABLE inbox_items (
    id                  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wallet_id           int NOT NULL DEFAULT app_wallet()
        CONSTRAINT fk_inbox_items_wallet REFERENCES wallets (id) ON DELETE CASCADE,
    created_by          int DEFAULT nullif(current_setting('app.user_id', true), '')::int
        CONSTRAINT fk_inbox_items_created_by REFERENCES users (id) ON DELETE SET NULL,
    -- Who sent it: the app or automation's own name, free text.
    source              varchar(64) NOT NULL,
    raw_text            text CHECK (length(raw_text) <= 2000),
    received_at         timestamptz NOT NULL DEFAULT now(),
    amount              numeric(14,2) CHECK (amount > 0),
    tx_date             timestamp,
    merchant            varchar(255),
    type_id             int CONSTRAINT fk_inbox_items_type REFERENCES transaction_types (id),
    -- The same ends a transaction has: from_id is always a bank account; to_id
    -- a category (expense, income) or another account (transfer). Composite
    -- keys keep both in the item's own wallet -- foreign key checks ignore RLS
    -- -- and a deleted account only takes the proposal with it (SET NULL on
    -- the id column alone, Postgres 15+), never the item.
    from_id             int,
    to_id               int,
    -- How sure the proposal is, 0 to 1: the share of past transactions that
    -- agreed with it, or what the sender said. NULL = no opinion.
    type_confidence     numeric(3,2) CHECK (type_confidence BETWEEN 0 AND 1),
    category_confidence numeric(3,2) CHECK (category_confidence BETWEEN 0 AND 1),
    account_confidence  numeric(3,2) CHECK (account_confidence BETWEEN 0 AND 1),
    status              text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'dismissed')),
    -- The transaction an accepted item became. A plain id, not a foreign key:
    -- editing a transaction deletes and re-inserts it under the same id, and a
    -- key with ON DELETE SET NULL would forget the link on the first edit.
    transaction_id      int,
    resolved_at         timestamptz,
    CONSTRAINT fk_inbox_items_from FOREIGN KEY (from_id, wallet_id)
        REFERENCES accounts (id, wallet_id) ON DELETE SET NULL (from_id),
    CONSTRAINT fk_inbox_items_to   FOREIGN KEY (to_id, wallet_id)
        REFERENCES accounts (id, wallet_id) ON DELETE SET NULL (to_id),
    -- Resolved means resolved: no text left behind, and a date to say when.
    CONSTRAINT ck_inbox_items_resolved CHECK (
        (status = 'pending' AND resolved_at IS NULL)
        OR (status <> 'pending' AND resolved_at IS NOT NULL AND raw_text IS NULL))
);

COMMENT ON COLUMN inbox_items.created_by IS
    'Whose token sent it. Audit only: the data belongs to wallet_id.';
COMMENT ON COLUMN inbox_items.raw_text IS
    'The notification as received; cleared when the item is accepted or dismissed.';

-- The list the interface shows: this wallet's pending items, newest first.
CREATE INDEX idx_inbox_items_wallet_status ON inbox_items (wallet_id, status, received_at);

-- ----------------------------------------------------------------------------
-- Row Level Security: the same four policies as every other data table
-- ----------------------------------------------------------------------------
ALTER TABLE inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_items FORCE ROW LEVEL SECURITY;

CREATE POLICY wallet_read ON inbox_items FOR SELECT
    USING (wallet_id = app_wallet() AND (SELECT app_wallet_role()) IS NOT NULL);

CREATE POLICY wallet_insert ON inbox_items FOR INSERT
    WITH CHECK (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw');

CREATE POLICY wallet_update ON inbox_items FOR UPDATE
    USING      (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw')
    WITH CHECK (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw');

CREATE POLICY wallet_delete ON inbox_items FOR DELETE
    USING (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw');

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
-- 001's default privileges already cover tables created by the same owner;
-- said again here so that this file does not depend on who ran 001.
GRANT SELECT, INSERT, UPDATE, DELETE ON api_tokens, inbox_items TO bussola_app;
