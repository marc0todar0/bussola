-- ============================================================================
-- 006 -- A push subscription belongs to the session that turned it on
-- ============================================================================
-- In 005 a subscription belonged to a person and lived until the browser or
-- the person removed it. Signing out did not remove it, so a shared device
-- went on receiving the previous person's notifications after they had left.
--
-- From here a subscription is bound to the session that created it, with ON
-- DELETE CASCADE: whatever ends the session -- signing out, the expiry purge,
-- a password change elsewhere, an administrator disabling the account,
-- deleting it -- takes the subscription with it, server-side, whatever the
-- browser does. The sender also skips subscriptions whose session has expired
-- but not yet been purged (auth/pushStore.js).
--
-- The rows 005 wrote have no session to be bound to, so they are deleted: the
-- people who had notifications on turn them on again from the Profile.
-- ============================================================================

DELETE FROM push_subscriptions;

ALTER TABLE push_subscriptions
    ADD COLUMN session_hash text NOT NULL
        CONSTRAINT fk_push_subscriptions_session
        REFERENCES sessions (token_hash) ON DELETE CASCADE;

CREATE INDEX idx_push_subscriptions_session ON push_subscriptions (session_hash);

COMMENT ON COLUMN push_subscriptions.session_hash IS
    'The session (sessions.token_hash) that subscribed this device: ending the session removes the subscription.';
