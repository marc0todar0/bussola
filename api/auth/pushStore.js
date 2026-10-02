// ---------------------------------------------------------------------------
// Web Push storage: subscriptions and the VAPID key pair
// ---------------------------------------------------------------------------
// push_subscriptions and server_secrets are identity-side tables (migration
// 005): no Row Level Security, reached only from api/auth/ through
// db.queryAuth(). Every statement that serves a signed-in person names their
// user id, taken from the session and never from the request; the two
// statements that serve the sender (a wallet's subscriptions, one person's)
// are the same kind of lookup writersByWallet() in wallets.js is.
const db = require("../dbConn");

// At most this many devices per person: the oldest is dropped for a new one.
const MAX_PER_USER = 10;

// --- the server's secrets ----------------------------------------------------
const readSecret = async (name) => {
  const { rows } = await db.queryAuth("SELECT value FROM server_secrets WHERE name = $1", [name]);
  return rows[0] ? rows[0].value : null;
};

// Stores the value only if there is none yet, and returns what is stored: two
// API replicas starting together both end up with the same key pair.
const createSecretOnce = async (name, value) => {
  await db.queryAuth(
    "INSERT INTO server_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
    [name, value],
  );
  return readSecret(name);
};

// --- subscriptions -----------------------------------------------------------
// A subscription is bound to the session that saved it (migration 006):
// ending the session deletes it. sessionHash is sessions.token_hash of the
// caller's own session (sessions.fingerprint of the cookie), never something
// the request names.
//
// Idempotent on the endpoint. An endpoint that belonged to another session --
// the same browser signed in again, or as somebody else -- moves to the
// caller's session and account. A session is one browser, so any other
// endpoint the same session had saved (the browser rotated its subscription)
// goes. Then the oldest beyond MAX_PER_USER go.
const saveSubscription = async (userId, sessionHash, { endpoint, p256dh, auth, userAgent }) => {
  const { rows } = await db.queryAuth(
    `INSERT INTO push_subscriptions AS s (user_id, session_hash, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE
        SET created_at   = CASE WHEN s.user_id = EXCLUDED.user_id THEN s.created_at ELSE now() END,
            user_id      = EXCLUDED.user_id,
            session_hash = EXCLUDED.session_hash,
            p256dh       = EXCLUDED.p256dh,
            auth         = EXCLUDED.auth,
            user_agent   = EXCLUDED.user_agent
     RETURNING id`,
    [userId, sessionHash, endpoint, p256dh, auth, userAgent || null],
  );
  await db.queryAuth(
    "DELETE FROM push_subscriptions WHERE user_id = $1 AND session_hash = $2 AND id <> $3",
    [userId, sessionHash, rows[0].id],
  );
  await db.queryAuth(
    `DELETE FROM push_subscriptions
      WHERE user_id = $1
        AND id IN (SELECT id FROM push_subscriptions WHERE user_id = $1
                    ORDER BY created_at DESC, id DESC OFFSET $2)`,
    [userId, MAX_PER_USER],
  );
  return rows[0].id;
};

// True when the caller had that subscription; somebody else's endpoint is
// simply not found.
const removeSubscription = async (userId, endpoint) => {
  const { rowCount } = await db.queryAuth(
    "DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2",
    [userId, endpoint],
  );
  return rowCount > 0;
};

// Whether this endpoint is subscribed for the caller's own session: what the
// Profile asks on opening, since the browser's own subscription may have been
// saved by a session that has since ended (signed out, another account).
const isSubscribed = async (userId, sessionHash, endpoint) => {
  const { rows } = await db.queryAuth(
    "SELECT 1 FROM push_subscriptions WHERE user_id = $1 AND session_hash = $2 AND endpoint = $3",
    [userId, sessionHash, endpoint],
  );
  return rows.length > 0;
};

// What the sender cleans up: a subscription the push service says is gone.
const dropSubscription = (id, userId) =>
  db.queryAuth("DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2", [id, userId]);

const touchSubscription = (id, userId) =>
  db.queryAuth("UPDATE push_subscriptions SET last_used_at = now() WHERE id = $1 AND user_id = $2", [id, userId]);

// The devices to tell when something waits in a wallet: those of its active
// members who may write there (a read-only member cannot confirm anything,
// a disabled account hears nothing), with the member's language. Only
// subscriptions whose session is still open: one expired but not yet purged
// hears nothing either.
const subscriptionsForWallet = async (walletId) => {
  const { rows } = await db.queryAuth(
    `SELECT s.id, s.user_id, u.locale, s.endpoint, s.p256dh, s.auth
       FROM wallet_members m
       JOIN users u ON u.id = m.user_id AND u.active
       JOIN push_subscriptions s ON s.user_id = u.id
       JOIN sessions ss ON ss.token_hash = s.session_hash AND ss.user_id = s.user_id
                       AND ss.expires_at > now()
      WHERE m.wallet_id = $1 AND m.role = 'rw'
      ORDER BY s.id`,
    [walletId],
  );
  return rows;
};

// One person's devices, for the test notification: open sessions only, as above.
const subscriptionsForUser = async (userId) => {
  const { rows } = await db.queryAuth(
    `SELECT s.id, s.user_id, u.locale, s.endpoint, s.p256dh, s.auth
       FROM push_subscriptions s JOIN users u ON u.id = s.user_id
       JOIN sessions ss ON ss.token_hash = s.session_hash AND ss.user_id = s.user_id
                       AND ss.expires_at > now()
      WHERE s.user_id = $1
      ORDER BY s.id`,
    [userId],
  );
  return rows;
};

module.exports = {
  MAX_PER_USER,
  readSecret,
  createSecretOnce,
  saveSubscription,
  removeSubscription,
  isSubscribed,
  dropSubscription,
  touchSubscription,
  subscriptionsForWallet,
  subscriptionsForUser,
};
