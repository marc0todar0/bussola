-- ============================================================================
-- 005 -- Web Push: a phone's subscriptions, and the server's own VAPID key
-- ============================================================================
-- When a draft reaches the inbox, the browsers of the people who can confirm
-- it may be told (api/services/push.js), with no third-party app: the push
-- service of the browser's vendor delivers a short message to the installed
-- web app.
--
-- Both tables are identity-side, like passkeys and api_tokens: no Row Level
-- Security, reached only from api/auth/ and services/push.js through
-- db.queryAuth(), and every statement that serves a signed-in person names
-- their user id. A subscription belongs to a person and a device, not to a
-- wallet; which wallets' items it hears about is decided at send time from
-- the memberships.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Push subscriptions
-- ----------------------------------------------------------------------------
-- What a browser's PushManager.subscribe() returned: an endpoint (a URL on the
-- browser vendor's push service, unguessable, and the address the server
-- POSTs to) and two keys the message is encrypted with. The endpoint is
-- unique across people: a browser profile that signs in as somebody else
-- hands the same endpoint to the new account, and the row moves to them.
--
-- The endpoint is a secret of sorts (whoever holds it can send this device
-- spam), so it is never logged and never returned to anybody but its owner.
CREATE TABLE push_subscriptions (
    id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      int         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint     text        NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 20 AND 1024),
    p256dh       text        NOT NULL CHECK (length(p256dh) BETWEEN 20 AND 256),
    auth         text        NOT NULL CHECK (length(auth) BETWEEN 8 AND 128),
    -- Which device it is, as the browser says: only for telling two entries
    -- apart, never trusted.
    user_agent   text        CHECK (length(user_agent) <= 200),
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);

COMMENT ON TABLE push_subscriptions IS
    'Web Push subscriptions of a person''s devices: the push service URL and the keys its messages are encrypted with.';
COMMENT ON COLUMN push_subscriptions.last_used_at IS
    'When a message was last accepted by the push service for this subscription.';

-- ----------------------------------------------------------------------------
-- The server's own secrets
-- ----------------------------------------------------------------------------
-- A small name -> value table for what the instance generates for itself and
-- must keep across restarts and between API replicas. Today one row,
-- 'vapid': the key pair that identifies this server to the push services,
-- as JSON {publicKey, privateKey}, created at the first start with Web Push
-- enabled. The private key never leaves the API: not in a log, an error or an
-- answer. (A database dump contains it, as it contains every session hash;
-- with it someone could push to existing subscriptions, which also needs
-- their endpoints, which sit in the same dump.)
CREATE TABLE server_secrets (
    name       text        PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 64),
    value      text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE server_secrets IS
    'Secrets the instance generated for itself (the VAPID key pair): API only, never returned.';

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
-- 001's default privileges already cover tables created by the same owner;
-- said again here so that this file does not depend on who ran 001.
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions, server_secrets TO bussola_app;
