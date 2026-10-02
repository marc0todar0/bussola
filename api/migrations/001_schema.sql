-- ============================================================================
-- 001 -- Bussola's schema
-- ============================================================================
-- Applied automatically at API startup by the runner in api/migrate.js, which
-- wraps the file in a transaction (so: no BEGIN/COMMIT here) and records it in
-- schema_migrations. Never edit a released migration: add 002_... instead.
--
-- This one file is the whole schema. The seventeen migrations that built it
-- before the first public release were folded into it; a database that ran all
-- of them is recognised by the runner and recorded as being at this one, with
-- nothing re-applied (see squashHistory() in migrate.js).
--
-- The shape, in the order of the sections below:
--
--   * the application role, bussola_app, and what it may touch;
--   * lookup tables: a small global taxonomy whose ids the code hardcodes;
--   * identity: users, wallets, memberships, sessions, passkeys, throttles.
--     No Row Level Security -- signing in has to read them before anyone is
--     known -- and reached only from api/auth/ through db.queryAuth();
--   * the helper functions the policies decide through;
--   * the data: accounts, transactions, holdings, portfolio snapshots, and
--     holding_types, which is half lookup and half data. Every row carries
--     wallet_id, and Row Level Security keeps each wallet to its members;
--   * triggers, indexes, policies, seed rows, grants.
-- ============================================================================

-- Accent-insensitive search in the transaction list: "caffe" finds "Caffè".
-- unaccent ships with the Postgres image and is a trusted extension; its
-- function is executable by PUBLIC, so bussola_app needs no grant of its own.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

-- ----------------------------------------------------------------------------
-- The application role
-- ----------------------------------------------------------------------------
-- PGUSER is the superuser the Postgres image creates, and superusers bypass
-- Row Level Security -- even with FORCE. If the API connected as PGUSER the
-- policies below would filter nothing and the isolation would be a fiction.
--
-- So PGUSER stays the owner and is used only for migrations (which must be
-- able to touch every wallet's rows), while the API connects as bussola_app,
-- an ordinary role that RLS applies to. Its password is set by
-- configureAppRole() in api/migrate.js on every boot: a SQL file cannot
-- generate one. The grants are at the end of this file, once the objects
-- exist.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bussola_app') THEN
        CREATE ROLE bussola_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END $$;

-- ============================================================================
-- Lookup tables
-- ============================================================================
-- Global and shared by every wallet: a taxonomy, not personal data. The seeded
-- ids are hardcoded in the controllers, so the rows are part of the schema
-- (inserted at the end of this file).
--
-- `name` is display text; `code` is the stable key every rule, filter and
-- comparison uses. The interface translates the code, so translating `name`
-- would only move the problem to another language.

-- What an `accounts` row is: 1 = expense category, 2 = income category,
-- 3 = bank account.
CREATE TABLE account_types (
    id   int PRIMARY KEY NOT NULL,
    name varchar(255),
    code varchar(40)
);

-- 1 = expense, 2 = income, 3 = transfer.
CREATE TABLE transaction_types (
    id   int PRIMARY KEY NOT NULL,
    name varchar(255),
    code varchar(40)
);

-- The four pillars of the asset allocation a holding is assigned to: cash,
-- emergency fund, planned expenses, long term.
CREATE TABLE pillars (
    id    int PRIMARY KEY NOT NULL,
    name  varchar(255),
    color varchar(255),
    code  varchar(40)
);

CREATE UNIQUE INDEX uq_account_types_code     ON account_types (code);
CREATE UNIQUE INDEX uq_transaction_types_code ON transaction_types (code);
CREATE UNIQUE INDEX uq_pillars_code           ON pillars (code);

-- ============================================================================
-- Identity: users, wallets, memberships, sessions, passkeys, throttles
-- ============================================================================
-- None of these has Row Level Security. Signing in has to find a username or
-- a credential before anyone is known, and the wallet picker has to list the
-- wallets you can reach before one is chosen. Access is confined to api/auth/
-- through db.queryAuth(), and every statement that serves a signed-in person
-- names their user id.

-- The API draws ids from these sequences (nextval) rather than from column
-- defaults.
CREATE SEQUENCE seq_users START 1;
CREATE SEQUENCE seq_wallets START 1;

CREATE TABLE users (
    id             int PRIMARY KEY NOT NULL,
    -- The one name an account has: there is no separate display name. The
    -- application has never sent mail, so there is no reason for the login to
    -- be an address.
    username       varchar(320) NOT NULL,
    password_hash  text,
    locale         varchar(10)  NOT NULL DEFAULT 'en',
    -- A vestige of the schema before wallets: nothing has ever written to it.
    -- The unit amounts are counted in is wallets.currency, because members of
    -- one wallet must read the same numbers in the same unit.
    currency       varchar(3)   NOT NULL DEFAULT 'EUR',
    is_admin       boolean      NOT NULL DEFAULT false,
    -- An administrator's decision, and nothing else: the automatic lock after
    -- wrong passwords is locked_until.
    active         boolean      NOT NULL DEFAULT true,
    created_at     timestamptz  NOT NULL DEFAULT now(),
    last_login     timestamptz,
    email          varchar(320),
    failed_logins  int          NOT NULL DEFAULT 0,
    locked_at      timestamptz,
    -- The WebAuthn user handle: stable, so that a second passkey on the same
    -- device replaces the first; random rather than the numeric id, so that
    -- it tells the device nothing about this database.
    passkey_handle text UNIQUE,
    -- Five wrong passwords in a row lock new sign-ins until then -- 15 minutes,
    -- doubling with each consecutive lock (lockouts) up to a day; see
    -- api/auth/lockout.js. Open sessions survive it, so a stranger's guesses
    -- cannot sign the owner out.
    locked_until   timestamptz,
    lockouts       int          NOT NULL DEFAULT 0
);

-- Case-insensitive uniqueness, with no extension needed.
CREATE UNIQUE INDEX uq_users_username ON users (lower(username));

COMMENT ON COLUMN users.username IS 'Login identifier. Case-insensitively unique.';
COMMENT ON COLUMN users.email    IS 'Optional contact address. Nothing sends to it yet.';
COMMENT ON COLUMN users.failed_logins IS
    'Consecutive failed sign-ins; reset to 0 on success.';
COMMENT ON COLUMN users.locked_at IS
    'When the last automatic lock began. active = false is an administrator''s decision, not this.';
COMMENT ON COLUMN users.passkey_handle IS
    'WebAuthn user handle (base64url of 32 random bytes). NULL until the first passkey.';
COMMENT ON COLUMN users.locked_until IS
    'Automatic lock after repeated wrong passwords: sign-ins are refused until then. NULL when not locked.';
COMMENT ON COLUMN users.lockouts IS
    'Consecutive automatic locks; each one lasts twice as long as the one before.';

-- The data belongs to a wallet, not to a user: people reach it through a
-- membership that carries a role.
CREATE TABLE wallets (
    id         int PRIMARY KEY NOT NULL,
    name       varchar(120) NOT NULL,
    -- Who created it, and therefore who manages its members alongside the
    -- instance administrator. SET NULL rather than CASCADE: deleting the
    -- person must not delete a wallet other people are using.
    created_by int REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- The currency belongs to the wallet and not to the reader: two members
    -- look at the same rows, and the language may differ between them while
    -- the unit may not. char(3) because an ISO 4217 code is exactly three
    -- letters; the list the interface offers is narrower and is enforced by
    -- the API (api/auth/wallets.js).
    currency   char(3) NOT NULL DEFAULT 'EUR'
        CONSTRAINT ck_wallets_currency CHECK (currency ~ '^[A-Z]{3}$')
);

COMMENT ON COLUMN wallets.currency IS
    'ISO 4217 code the wallet''s amounts are counted in. Shared by every member: the language is personal, the unit is not.';

CREATE TABLE wallet_members (
    wallet_id  int NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
    user_id    int NOT NULL REFERENCES users (id)   ON DELETE CASCADE,
    role       varchar(2) NOT NULL CHECK (role IN ('rw', 'r')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (wallet_id, user_id)
);

COMMENT ON TABLE  wallet_members IS
    'Who can reach which wallet, and with what right. Read by the RLS policies.';
COMMENT ON COLUMN wallet_members.role IS 'rw = read and write, r = read only.';

-- Cookie sessions. In a table rather than in memory: they survive a restart
-- and can be revoked one by one.
CREATE TABLE sessions (
    -- sha256 of the token, never the token itself.
    token_hash text PRIMARY KEY,
    user_id    int NOT NULL
        CONSTRAINT fk_sessions_user REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    user_agent varchar(255),
    -- The wallet the session is looking at: a server-side fact, not something
    -- the client sends, and per device. SET NULL so that deleting a wallet
    -- drops everybody back to the picker instead of deleting their sessions.
    wallet_id  int REFERENCES wallets (id) ON DELETE SET NULL
);

-- Passkeys (WebAuthn): a second way to prove who you are, never a replacement
-- for the password. The device keeps the private key; only the public half is
-- here. A passkey belongs to a person, not to a wallet.
CREATE TABLE passkeys (
    id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        int         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- The credential id the authenticator chose, base64url as it travels in
    -- the WebAuthn JSON. At sign-in it is the only thing that says whose
    -- passkey this is, hence globally unique.
    credential_id  text        NOT NULL UNIQUE,
    -- COSE-encoded public key.
    public_key     bytea       NOT NULL,
    -- The authenticator's signature counter. Synced passkeys always report 0;
    -- those that count let a cloned authenticator be noticed.
    counter        bigint      NOT NULL DEFAULT 0,
    -- "internal", "hybrid", "usb"...: handed back so the browser offers the
    -- right prompt.
    transports     text[]      NOT NULL DEFAULT '{}',
    name           text        NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_used_at   timestamptz
);

COMMENT ON TABLE passkeys IS
    'WebAuthn credentials: an additional way to sign in. The password always remains.';

-- Challenges in flight between the start and the end of a WebAuthn ceremony.
-- A table rather than process memory because the API may run as several
-- replicas, and the two requests need not land on the same one. Single-use:
-- redeemed by DELETE ... RETURNING, so a signed response cannot be replayed.
-- Expired rows are swept whenever a new challenge is issued.
CREATE TABLE passkey_challenges (
    challenge   text        PRIMARY KEY,
    -- 'register' challenges are issued to a signed-in account that has just
    -- typed its password again, and only that account may redeem them;
    -- 'authenticate' challenges belong to nobody until a passkey signs one.
    purpose     text        NOT NULL CHECK (purpose IN ('register', 'authenticate')),
    user_id     int         REFERENCES users (id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK ((purpose = 'register') = (user_id IS NOT NULL))
);

-- The throttles of api/auth/throttle.js: one row per limiter and key, a fixed
-- window of `n` hits since `first_at`. In the database so that several API
-- replicas share the counts and a restart does not reset them. The key is
-- stored as its sha256: it is built from an address and a username, and a
-- counter has no need to read either back.
--
-- UNLOGGED: it is written on every failed sign-in, and a counter lost in a
-- crash costs nothing. The durable brake is the account lock on users.
CREATE UNLOGGED TABLE throttle_hits (
    limiter  text        NOT NULL,
    key_hash bytea       NOT NULL,
    n        int         NOT NULL,
    first_at timestamptz NOT NULL,
    PRIMARY KEY (limiter, key_hash)
);

-- ============================================================================
-- The helpers the policies decide through
-- ============================================================================
-- Plain SQL and SECURITY INVOKER on purpose. SECURITY DEFINER would buy
-- nothing -- wallet_members has no RLS of its own (should that ever change,
-- these two have to be revisited with it) -- and would stop the planner from
-- inlining app_wallet(), which is what lets it use the (wallet_id, ...)
-- indexes at all.
--
-- app_wallet_role() reads a table, so it is not inlined: the policies call it
-- as a scalar sub-select, `(SELECT app_wallet_role())`, which the planner
-- turns into an InitPlan evaluated once per statement instead of once per row.
-- It is still read when the statement runs, so a revoked or demoted membership
-- bites on the very next query.
--
-- Setting app.wallet_id grants nothing: the role is looked up for the pair
-- (app.user_id, app.wallet_id), so a wallet the caller is not a member of
-- yields NULL.
CREATE FUNCTION app_wallet() RETURNS int
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.wallet_id', true), '')::int
$$;

CREATE FUNCTION app_wallet_role() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT m.role
      FROM wallet_members m
     WHERE m.wallet_id = nullif(current_setting('app.wallet_id', true), '')::int
       AND m.user_id   = nullif(current_setting('app.user_id',   true), '')::int
$$;

COMMENT ON FUNCTION app_wallet_role() IS
    'The caller''s role on the wallet in context, or NULL if they are not a member.';

-- ============================================================================
-- The data
-- ============================================================================
-- Every data table carries wallet_id, denormalized rather than reached through
-- a join: it keeps the policies trivial and the indexes usable. Its default
-- reads the session context, so the application's INSERTs never name it.
--
-- created_by is who entered the row: audit only, nullable, SET NULL when the
-- user goes. Nothing filters on it; the row belongs to its wallet.
--
-- Money is numeric, never float: a balance is kept by adding each transaction
-- to the one before, and binary fractions drift (4199.959999999992 where
-- 4199.96 was meant). Amounts are numeric(14,2), exact cents; quantities and
-- unit prices are not amounts in the wallet's unit and get scales of their
-- own. dbConn.js turns numeric back into a JS number in one place.

CREATE SEQUENCE seq_accounts START 1;
CREATE SEQUENCE seq_transactions START 1;
CREATE SEQUENCE seq_holdings START 1;
CREATE SEQUENCE seq_portfolio_snapshots START 1;
CREATE SEQUENCE seq_holding_types START 1;

-- Bank accounts and categories in one table: is_account tells them apart, and
-- type_id says which kind (account_types).
CREATE TABLE accounts (
    id            int PRIMARY KEY NOT NULL,
    name          varchar(255),
    color         varchar(255),
    icon          varchar(255),
    icon_family   varchar(255),
    -- The balance.
    amount        numeric(14,2),
    type_id       int CONSTRAINT fk_accounts_type REFERENCES account_types (id),
    description   varchar(255),
    -- true = bank account, false = expense or income category.
    is_account    boolean NOT NULL,
    -- For an investment account, the value of its holdings (their sum); NULL
    -- reads as the balance. Transactions leave it alone.
    actual_amount numeric(14,2),
    archived      boolean NOT NULL DEFAULT false,
    is_current    boolean NOT NULL DEFAULT true,
    is_investment boolean NOT NULL DEFAULT false,
    created_by    int DEFAULT nullif(current_setting('app.user_id', true), '')::int
        CONSTRAINT fk_accounts_created_by REFERENCES users (id) ON DELETE SET NULL,
    wallet_id     int NOT NULL DEFAULT nullif(current_setting('app.wallet_id', true), '')::int
        CONSTRAINT fk_accounts_wallet REFERENCES wallets (id) ON DELETE CASCADE,
    -- The target of the composite foreign keys below.
    CONSTRAINT uq_accounts_id_wallet UNIQUE (id, wallet_id)
);

COMMENT ON COLUMN accounts.created_by IS
    'Who entered the row. Audit only: the data belongs to wallet_id.';

-- A name is unique in its wallet, per kind. Two accounts called "Current
-- account" cannot be told apart in a picker, and the export refers to
-- accounts by name (an id means nothing in another instance), so the import
-- would fold them into one. Per kind (type_id): bank accounts, expense and
-- income categories each have their own names, so "Gifts" may be both
-- something you spend on and something you receive. Case and surrounding
-- spaces do not make a name different -- the import matches names the same
-- way. The index starts with wallet_id: a name used in another wallet is free
-- in yours, and trying it reveals nothing about theirs.
CREATE UNIQUE INDEX uq_accounts_wallet_type_name
    ON accounts (wallet_id, type_id, lower(btrim(name)));

-- Foreign key checks run as the system and ignore RLS. Without (id, wallet_id)
-- one wallet's transaction could reference another wallet's account, and that
-- account's name would show up in a list it has no business being in. The
-- same holds for holdings below.
CREATE TABLE transactions (
    id          int PRIMARY KEY NOT NULL,
    from_id     int NOT NULL,
    to_id       int NOT NULL,
    amount      numeric(14,2),
    type_id     int CONSTRAINT fk_transactions_type REFERENCES transaction_types (id),
    description varchar(255),
    -- A timestamp, not a date: a period is the half-open range
    -- tx_date >= from AND tx_date < to + 1 day (api/services/period.js).
    tx_date     timestamp,
    updated_at  timestamp DEFAULT CURRENT_TIMESTAMP,
    created_by  int DEFAULT nullif(current_setting('app.user_id', true), '')::int
        CONSTRAINT fk_transactions_created_by REFERENCES users (id) ON DELETE SET NULL,
    wallet_id   int NOT NULL DEFAULT nullif(current_setting('app.wallet_id', true), '')::int
        CONSTRAINT fk_transactions_wallet REFERENCES wallets (id) ON DELETE CASCADE,
    -- Who last changed the row; NULL = never changed. An edit is not an
    -- UPDATE -- the controller deletes the row and inserts it again under the
    -- same id, so the balances move by exactly the row removed -- and it is
    -- that insert which carries created_by over and writes updated_by. So no
    -- trigger could fill it.
    updated_by  int
        CONSTRAINT fk_transactions_updated_by REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_transactions_from FOREIGN KEY (from_id, wallet_id)
        REFERENCES accounts (id, wallet_id),
    CONSTRAINT fk_transactions_to   FOREIGN KEY (to_id, wallet_id)
        REFERENCES accounts (id, wallet_id)
);

COMMENT ON COLUMN transactions.created_by IS
    'Who entered the row. Audit only: the data belongs to wallet_id.';
COMMENT ON COLUMN transactions.updated_by IS
    'Who last changed the row (NULL: never changed). Audit only: the data belongs to wallet_id.';

-- Holding types are half lookup and half data:
--   * wallet_id NULL -> the seeded taxonomy (ETF, crypto, bonds...), shared by
--                       every wallet and read-only to the application;
--   * wallet_id set  -> a type a wallet invented from the holding form,
--                       visible and removable only there.
-- The default is app_wallet(), so the application's inserts land in the
-- wallet in context, and the insert policy refuses any other value -- NULL
-- included, so the application can never add to the shared taxonomy. With no
-- context (a migration, psql) a row inserted is global, which is what seeding
-- wants.
CREATE TABLE holding_types (
    id        int PRIMARY KEY NOT NULL,
    name      varchar(255) NOT NULL,
    color     varchar(255),
    code      varchar(40),
    wallet_id int DEFAULT app_wallet() REFERENCES wallets (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_holding_types_code ON holding_types (code);

-- The instruments inside an investment account. amount is the current value,
-- quantity x current_price when both are known (quotes refreshed
-- automatically), typed by hand otherwise; their sum is the account's
-- actual_amount.
CREATE TABLE holdings (
    id               int PRIMARY KEY NOT NULL,
    account_id       int NOT NULL,
    name             varchar(255),
    pillar_id        int NOT NULL DEFAULT 1
        CONSTRAINT fk_holdings_pillar REFERENCES pillars (id),
    amount           numeric(14,2) NOT NULL DEFAULT 0,
    description      varchar(255),
    -- Removing a type leaves its holdings without one: a holding's value does
    -- not depend on its type, so there is nothing to protect by refusing.
    type_id          int
        CONSTRAINT fk_holdings_type REFERENCES holding_types (id) ON DELETE SET NULL,
    issuer           varchar(255),
    country          varchar(100),
    currency         varchar(3),
    isin             varchar(12),
    quantity         numeric(28,12),
    purchase_price   numeric(24,10),
    purchase_date    date,
    current_price    numeric(24,10),
    price_updated_at timestamp,
    auto_update      boolean NOT NULL DEFAULT true,
    updated_at       timestamp DEFAULT CURRENT_TIMESTAMP,
    created_by       int DEFAULT nullif(current_setting('app.user_id', true), '')::int
        CONSTRAINT fk_holdings_created_by REFERENCES users (id) ON DELETE SET NULL,
    wallet_id        int NOT NULL DEFAULT nullif(current_setting('app.wallet_id', true), '')::int
        CONSTRAINT fk_holdings_wallet REFERENCES wallets (id) ON DELETE CASCADE,
    CONSTRAINT fk_holdings_account FOREIGN KEY (account_id, wallet_id)
        REFERENCES accounts (id, wallet_id) ON DELETE CASCADE
);

COMMENT ON COLUMN holdings.created_by IS
    'Who entered the row. Audit only: the data belongs to wallet_id.';

-- One row per wallet and month: the portfolio's total and its value per
-- pillar (value_p1..p4, the history chart), plus `detail`, the frozen
-- breakdown read only when somebody opens that month.
CREATE TABLE portfolio_snapshots (
    id         int PRIMARY KEY NOT NULL,
    year       int NOT NULL,
    month      int NOT NULL,
    total      numeric(14,2) NOT NULL DEFAULT 0,
    value_p1   numeric(14,2) NOT NULL DEFAULT 0,
    value_p2   numeric(14,2) NOT NULL DEFAULT 0,
    value_p3   numeric(14,2) NOT NULL DEFAULT 0,
    value_p4   numeric(14,2) NOT NULL DEFAULT 0,
    detail     jsonb,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    created_by int DEFAULT nullif(current_setting('app.user_id', true), '')::int
        CONSTRAINT fk_portfolio_snapshots_created_by REFERENCES users (id) ON DELETE SET NULL,
    wallet_id  int NOT NULL DEFAULT nullif(current_setting('app.wallet_id', true), '')::int
        CONSTRAINT fk_portfolio_snapshots_wallet REFERENCES wallets (id) ON DELETE CASCADE,
    -- Per wallet: otherwise two wallets -- or two members of one -- would
    -- overwrite each other's month.
    CONSTRAINT uq_snapshots_period UNIQUE (wallet_id, year, month)
);

COMMENT ON COLUMN portfolio_snapshots.created_by IS
    'Who entered the row. Audit only: the data belongs to wallet_id.';

-- ============================================================================
-- Triggers
-- ============================================================================
CREATE FUNCTION trg_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_updated_at
    BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- A holding may only use a type its own wallet can see. The foreign key
-- accepts any id that exists, and foreign-key checks ignore RLS: without this
-- a holding in wallet A could point at a type wallet B invented. A composite
-- key (type_id, wallet_id), which does this job for accounts, cannot say
-- "global or mine" -- the global rows have no wallet -- so a trigger says it.
-- The predicate names the wallet explicitly rather than trusting the caller's
-- RLS, so it holds for the table owner too.
--
-- 23503 is foreign_key_violation, which publicError() answers with a generic
-- 400 INVALID_REQUEST.
CREATE FUNCTION holding_type_in_wallet() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.type_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM holding_types t
         WHERE t.id = NEW.type_id
           AND (t.wallet_id IS NULL OR t.wallet_id = NEW.wallet_id)
    ) THEN
        RAISE EXCEPTION 'holding type % is not available in wallet %', NEW.type_id, NEW.wallet_id
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_holdings_type_in_wallet
    BEFORE INSERT OR UPDATE OF type_id, wallet_id ON holdings
    FOR EACH ROW EXECUTE FUNCTION holding_type_in_wallet();

-- ============================================================================
-- Indexes
-- ============================================================================
CREATE INDEX idx_wallet_members_user     ON wallet_members (user_id);
CREATE INDEX idx_sessions_user           ON sessions (user_id);
CREATE INDEX idx_sessions_expiry         ON sessions (expires_at);
CREATE INDEX idx_passkeys_user           ON passkeys (user_id);
CREATE INDEX idx_passkey_challenges_expiry ON passkey_challenges (expires_at);
-- For the sweep of expired throttle windows.
CREATE INDEX idx_throttle_hits_first_at  ON throttle_hits (first_at);

CREATE INDEX idx_accounts_wallet_kind    ON accounts (wallet_id, is_account);
CREATE INDEX idx_holdings_wallet_account ON holdings (wallet_id, account_id);
CREATE INDEX idx_snapshots_wallet_period ON portfolio_snapshots (wallet_id, year, month);

-- The transaction list is paged by day, newest first, with the id as the
-- tie-breaker.
CREATE INDEX idx_transactions_wallet_date_id   ON transactions (wallet_id, tx_date, id);
-- The type filter, and the transaction form's defaults: the last transaction
-- of each type, found by walking this index backwards.
CREATE INDEX idx_transactions_wallet_type_date ON transactions (wallet_id, type_id, tx_date, id);
-- An account or a category within a period: the drill-down from the summary.
-- They also serve the composite foreign keys' checks when an account is
-- deleted.
CREATE INDEX idx_transactions_wallet_from_date ON transactions (wallet_id, from_id, tx_date);
CREATE INDEX idx_transactions_wallet_to_date   ON transactions (wallet_id, to_id, tx_date);

-- ============================================================================
-- Row Level Security
-- ============================================================================
-- Isolation between wallets is enforced here, not by WHERE clauses in the
-- controllers. FORCE does nothing for bussola_app (it owns nothing) but
-- protects the case of somebody connecting as the owner: without it the
-- policies would be skipped in silence.
--
-- Four policies per table rather than one. Permissive policies are OR-ed, and
-- each command consults only the policies declared for it: a read-only member
-- matches wallet_read and nothing else, so SELECT works and INSERT, UPDATE and
-- DELETE have no policy that lets them through. Write permission is a policy,
-- not an `if`: the API answers 403 first because a policy violation is a poor
-- error message, but it is the second line, not the first.
--
-- With no context both helpers return NULL, every comparison is NULL, and
-- nothing passes. The default is closed, and verifyIsolation() checks it on
-- every boot.
DO $rls$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['accounts', 'transactions', 'holdings', 'portfolio_snapshots']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

        EXECUTE format($p$
            CREATE POLICY wallet_read ON %I FOR SELECT
                USING (wallet_id = app_wallet() AND (SELECT app_wallet_role()) IS NOT NULL)
        $p$, t);

        EXECUTE format($p$
            CREATE POLICY wallet_insert ON %I FOR INSERT
                WITH CHECK (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw')
        $p$, t);

        EXECUTE format($p$
            CREATE POLICY wallet_update ON %I FOR UPDATE
                USING      (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw')
                WITH CHECK (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw')
        $p$, t);

        EXECUTE format($p$
            CREATE POLICY wallet_delete ON %I FOR DELETE
                USING (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw')
        $p$, t);
    END LOOP;
END
$rls$;

-- holding_types gets the same four with one difference: reading also lets the
-- global rows through. Writing needs wallet_id = the wallet in context, which
-- a global row never matches, so the shared taxonomy cannot be touched from
-- the application at all.
ALTER TABLE holding_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE holding_types FORCE ROW LEVEL SECURITY;

CREATE POLICY wallet_read ON holding_types FOR SELECT
    USING (wallet_id IS NULL
           OR (wallet_id = app_wallet() AND (SELECT app_wallet_role()) IS NOT NULL));

CREATE POLICY wallet_insert ON holding_types FOR INSERT
    WITH CHECK (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw');

CREATE POLICY wallet_update ON holding_types FOR UPDATE
    USING      (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw')
    WITH CHECK (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw');

CREATE POLICY wallet_delete ON holding_types FOR DELETE
    USING (wallet_id = app_wallet() AND (SELECT app_wallet_role()) = 'rw');

-- ============================================================================
-- Seed rows
-- ============================================================================
-- Required, not sample data: the ids are hardcoded in the controllers and the
-- codes in the interface. The names are English display text; the interface
-- shows the translated code.
INSERT INTO account_types (id, name, code) VALUES
    (1, 'Expenses',         'EXPENSE'),
    (2, 'Income',           'INCOME'),
    (3, 'Standard account', 'STANDARD_ACCOUNT');

INSERT INTO transaction_types (id, name, code) VALUES
    (1, 'Expense',  'EXPENSE'),
    (2, 'Income',   'INCOME'),
    (3, 'Transfer', 'TRANSFER');

INSERT INTO pillars (id, name, color, code) VALUES
    (1, 'Cash',             '#42a5f5', 'CASH'),
    (2, 'Emergency fund',   '#66bb6a', 'EMERGENCY_FUND'),
    (3, 'Planned expenses', '#ffa726', 'PLANNED_EXPENSES'),
    (4, 'Long term',        '#ef5350', 'LONG_TERM');

-- The global taxonomy (wallet_id NULL). This runs as the owner, which RLS
-- does not stop.
INSERT INTO holding_types (id, name, color, code, wallet_id) VALUES
    (1,  'ETF',                      '#26a69a', 'ETF',              NULL),
    (2,  'ETN',                      '#5c6bc0', 'ETN',              NULL),
    (3,  'ETP',                      '#7e57c2', 'ETP',              NULL),
    (4,  'Stock',                    '#ef5350', 'STOCK',            NULL),
    (5,  'Bond',                     '#ffa726', 'BOND',             NULL),
    (6,  'BTP',                      '#ffb74d', 'BTP',              NULL),
    (7,  'Crypto',                   '#ffca28', 'CRYPTO',           NULL),
    (8,  'Deposit account',          '#66bb6a', 'DEPOSIT_ACCOUNT',  NULL),
    (9,  'Fund',                     '#42a5f5', 'FUND',             NULL),
    (10, 'Cash',                     '#90a4ae', 'CASH',             NULL),
    (11, 'BOT',                      '#ffcc80', 'BOT',              NULL),
    (12, 'Interest-bearing account', '#81c784', 'INTEREST_ACCOUNT', NULL),
    (13, 'Money market ETF',         '#4db6ac', 'MONEY_MARKET_ETF', NULL);
SELECT setval('seq_holding_types', 13);

-- ============================================================================
-- Grants
-- ============================================================================
-- Every table and sequence, including the identity tables: those have no RLS,
-- but only api/auth/ reaches them. What bussola_app may *see* in the data
-- tables is the policies' business, not the grants'.
GRANT USAGE ON SCHEMA public TO bussola_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO bussola_app;
GRANT USAGE, SELECT                 ON ALL SEQUENCES IN SCHEMA public TO bussola_app;
GRANT EXECUTE ON FUNCTION app_wallet(), app_wallet_role() TO bussola_app;

-- schema_migrations (created by the runner before this file) stays out of the
-- API's reach: only the runner writes it.
REVOKE ALL ON schema_migrations FROM bussola_app;

-- Tables and sequences created by later migrations are reachable from the
-- start. For the owning role, whatever it is called on this installation.
DO $$
BEGIN
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bussola_app', current_user);
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'GRANT USAGE, SELECT ON SEQUENCES TO bussola_app', current_user);
END $$;
