const crypto = require("node:crypto");
const db = require("../dbConn");

const COOKIE_NAME = "bussola_sess";
const DURATION_DAYS = Number(process.env.BUSSOLA_SESSION_DAYS || 30);

// Only the sha256 of the token reaches the database: anyone reading the
// sessions table (a backup, a dump) gets nothing they can use. sha256 rather
// than a KDF because the token is already 32 random bytes, not a guessable
// password.
const fingerprint = (token) => crypto.createHash("sha256").update(token).digest("hex");

const createSession = async (userId, userAgent) => {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + DURATION_DAYS * 24 * 60 * 60 * 1000);

  await db.queryAuth(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [fingerprint(token), userId, expiresAt, (userAgent || "").slice(0, 255)],
  );

  return { token, expiresAt };
};

// Who is calling, and which wallet they are looking at.
//
// The membership is resolved here, on every request, rather than trusted from
// the session row: revoking somebody's access has to take effect at once, the
// way flipping users.active does, and not at their next sign-in. When the
// membership is gone the wallet reads as unchosen and the picker comes back --
// the session itself stays valid.
const userFromToken = async (token) => {
  if (!token) return null;

  const { rows } = await db.queryAuth(
    `SELECT u.id, u.username, u.email, u.locale, u.currency, u.is_admin, u.bank_names,
            s.wallet_id, w.name AS wallet_name, m.role AS wallet_role,
            w.currency AS wallet_currency, w.created_by AS wallet_created_by,
            s.expires_at AS session_expires_at
       FROM sessions s
       JOIN users    u ON u.id = s.user_id
       LEFT JOIN wallet_members m ON m.wallet_id = s.wallet_id AND m.user_id = u.id
       LEFT JOIN wallets       w ON w.id = s.wallet_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND u.active`,
    [fingerprint(token)],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    ...row,
    wallet: row.wallet_role
      ? {
          id: row.wallet_id,
          name: row.wallet_name,
          role: row.wallet_role,
          // The unit the amounts in this wallet are counted in. It belongs to
          // the wallet and not to the account looking at it: two members of
          // one wallet read the same numbers, so they have to read them in the
          // same currency. u.currency above is a vestige of the schema before
          // wallets, which nothing has ever written to, and is not it.
          currency: row.wallet_currency,
          // Whether this account may add and remove members here. The
          // interface needs it to decide what to draw; the endpoints check it
          // again for themselves.
          canManage: row.is_admin || row.wallet_created_by === row.id,
        }
      : null,
  };
};

// The chosen wallet lives on the session: server-side, so it survives a
// reload, and per device, so the phone and the laptop can be on two different
// wallets at once. Whether the caller may choose it is decided before this is
// called.
const setSessionWallet = (token, walletId) =>
  db.queryAuth("UPDATE sessions SET wallet_id = $2 WHERE token_hash = $1", [
    fingerprint(token),
    walletId,
  ]);

// A session lasts DURATION_DAYS from its last use, not from the sign-in:
// once less than half of it is left, a request pushes the end back to a full
// DURATION_DAYS from now. Somebody who opens Bussola at least that often is
// never signed out, and neither is the push subscription bound to the session
// (migration 006). Half, so it is one UPDATE every couple of weeks rather
// than one per request. Returns the new end, or null when nothing changed.
const renewIfDue = async (token, expiresAt) => {
  if (!token || !expiresAt) return null;
  const fullMs = DURATION_DAYS * 24 * 60 * 60 * 1000;
  if (new Date(expiresAt).getTime() - Date.now() > fullMs / 2) return null;
  const next = new Date(Date.now() + fullMs);
  const { rowCount } = await db.queryAuth(
    "UPDATE sessions SET expires_at = $2 WHERE token_hash = $1 AND expires_at > now()",
    [fingerprint(token), next],
  );
  return rowCount ? next : null;
};

const deleteSession = (token) =>
  db.queryAuth("DELETE FROM sessions WHERE token_hash = $1", [fingerprint(token)]);

// On a password change or a deactivation, every open session goes down.
const deleteUserSessions = (userId) =>
  db.queryAuth("DELETE FROM sessions WHERE user_id = $1", [userId]);

// A password change: every session of the account goes, and the caller gets
// a fresh one in place of the one it used. What belonged to the caller's
// session moves to the new one -- the wallet it was looking at (only while
// the membership still exists: the SELECT finds nothing once it has been
// revoked), and this device's push subscription, which would otherwise go
// down with the old session (migration 006). Everybody else's sessions, and
// their devices' subscriptions with them, are deleted. One transaction, so a
// failure leaves the old session as it was.
const replaceUserSessions = async (oldToken, userId, userAgent, walletId) => {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + DURATION_DAYS * 24 * 60 * 60 * 1000);
  const newHash = fingerprint(token);

  const keptWallet = await db.transactionAuth(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, wallet_id)
       VALUES ($1, $2, $3, $4,
               (SELECT wallet_id FROM wallet_members WHERE wallet_id = $5 AND user_id = $2))
       RETURNING wallet_id`,
      [newHash, userId, expiresAt, (userAgent || "").slice(0, 255), walletId || null],
    );
    if (oldToken) {
      await client.query(
        "UPDATE push_subscriptions SET session_hash = $1 WHERE session_hash = $2 AND user_id = $3",
        [newHash, fingerprint(oldToken), userId],
      );
    }
    await client.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [userId, newHash]);
    return rows[0].wallet_id;
  });

  return { token, expiresAt, walletId: keptWallet };
};

const purgeExpired = async () => {
  const { rowCount } = await db.queryAuth("DELETE FROM sessions WHERE expires_at <= now()");
  return rowCount;
};

// Opt-in, and off by default even in production: the standard Bussola
// deployment is plain http on a home network, and with secure set the browser
// would drop the cookie, leaving login broken with no explanation. Anyone
// serving it behind HTTPS sets BUSSOLA_COOKIE_SECURE=true.
const secureCookie = () => process.env.BUSSOLA_COOKIE_SECURE === "true";

const cookieOptions = (expiresAt) => ({
  httpOnly: true,
  sameSite: "lax",
  secure: secureCookie(),
  path: "/",
  expires: expiresAt,
});

module.exports = {
  COOKIE_NAME,
  fingerprint,
  DURATION_DAYS,
  createSession,
  renewIfDue,
  userFromToken,
  setSessionWallet,
  deleteSession,
  deleteUserSessions,
  replaceUserSessions,
  purgeExpired,
  cookieOptions,
};
