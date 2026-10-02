// ---------------------------------------------------------------------------
// Throttles
// ---------------------------------------------------------------------------
// Each limiter counts hits against a key inside a fixed window. Which hits
// count is the caller's decision: failures for the password checks, every
// attempt for sign-up.
//
// The counts live in the database (throttle_hits), not in the
// process: with several API replicas a Map per process gave every address one
// allowance per replica, and a restart forgot them all. The window is measured
// by the database's clock, so the replicas agree on it too. The keys are
// stored as their sha256 -- they carry addresses and usernames. The account
// lock (lockout.js) remains the durable brake; this is the one in front of it.
//
// A counter that cannot be read or written does not stop anybody: the error
// is logged and the request goes on as if the count were zero. A database that
// cannot answer this cannot answer the sign-in that follows either, and a
// throttle is not worth turning a hiccup into a lockout of everyone.
//
// The keys are built from req.ip, and req.ip is only as good as `trust proxy`
// in index.js. It trusts exactly as many hops as there are proxies in front of
// the API (BUSSOLA_TRUSTED_PROXIES, one by default: our nginx), so an
// X-Forwarded-For the client wrote itself is never what ends up here.
const crypto = require("node:crypto");
const db = require("../dbConn");

const hash = (key) => crypto.createHash("sha256").update(String(key)).digest();

// The window, as SQL, from a parameter holding milliseconds.
const WINDOW = (p) => `(${p}::int * interval '1 millisecond')`;

let longestWindow = 0;

const createLimiter = ({ name, windowMs, max }) => {
  longestWindow = Math.max(longestWindow, windowMs);

  const failed = (what, error) => console.error(`[throttle] ${name}: could not ${what}:`, error.message);

  return {
    // Seconds until the key may try again, or 0 when it may now.
    async blocked(key) {
      try {
        const { rows } = await db.queryAuth(
          `SELECT n, ceil(extract(epoch FROM first_at + ${WINDOW("$3")} - now()))::int AS wait
             FROM throttle_hits
            WHERE limiter = $1 AND key_hash = $2 AND first_at > now() - ${WINDOW("$3")}`,
          [name, hash(key), windowMs],
        );
        if (!rows[0] || rows[0].n < max) return 0;
        return Math.max(1, rows[0].wait);
      } catch (error) {
        failed("read the counter", error);
        return 0;
      }
    },

    // One statement, so two replicas counting the same key at the same moment
    // both count. A window that has run out starts again from this hit.
    async hit(key) {
      try {
        await db.queryAuth(
          `INSERT INTO throttle_hits AS t (limiter, key_hash, n, first_at)
           VALUES ($1, $2, 1, now())
           ON CONFLICT (limiter, key_hash) DO UPDATE
              SET n        = CASE WHEN t.first_at > now() - ${WINDOW("$3")} THEN t.n + 1 ELSE 1 END,
                  first_at = CASE WHEN t.first_at > now() - ${WINDOW("$3")} THEN t.first_at ELSE now() END`,
          [name, hash(key), windowMs],
        );
      } catch (error) {
        failed("count", error);
      }
    },

    async reset(key) {
      try {
        await db.queryAuth("DELETE FROM throttle_hits WHERE limiter = $1 AND key_hash = $2", [name, hash(key)]);
      } catch (error) {
        failed("reset the counter", error);
      }
    },
  };
};

// Expired windows are only ever overwritten by the next hit on the same key,
// so the rows of keys that never come back are swept. Every replica sweeps;
// the statement is idempotent. The first sweep can run before the pool exists
// on a slow start, which is one more reason for the catch.
setInterval(() => {
  db.queryAuth(`DELETE FROM throttle_hits WHERE first_at <= now() - ${WINDOW("$1")}`, [longestWindow]).catch(
    (error) => console.error("[throttle] sweep failed:", error.message),
  );
}, 5 * 60 * 1000).unref();

// The one answer every limiter gives, with the wait in a header as well so a
// script can honour it without parsing the body.
const tooMany = (res, seconds) => {
  res.set("Retry-After", String(seconds));
  return res.status(429).json({
    code: "TOO_MANY_ATTEMPTS",
    error: "Too many attempts. Try again in a few minutes.",
    retryAfter: seconds,
  });
};

const MINUTE = 60 * 1000;

// The limits, in one place. Chosen so that a person mistyping never meets
// them and a script gets nowhere; the account lock does the rest. The name is
// what the rows are stored under: renaming one starts its counts over.
const limits = {
  // Wrong passwords for one username from one address. Above the account
  // lock's five on purpose: that one is the real brake, and this only stops
  // an address from hammering an account that is already locked.
  loginPerUser: createLimiter({ name: "loginPerUser", windowMs: 15 * MINUTE, max: 20 }),
  // Wrong passwords from one address, whatever the username: what stops one
  // machine from trying a common password against every account in turn.
  loginPerIp: createLimiter({ name: "loginPerIp", windowMs: 15 * MINUTE, max: 100 }),
  // Failed passkey sign-ins from one address. A signature cannot be guessed,
  // but each attempt still costs a challenge row and a verification.
  passkeyPerIp: createLimiter({ name: "passkeyPerIp", windowMs: 15 * MINUTE, max: 30 }),
  // Every sign-up attempt from one address, successful or not: each one runs
  // a 64 MB scrypt and creates a wallet with starter data.
  signupPerIp: createLimiter({ name: "signupPerIp", windowMs: 60 * MINUTE, max: 30 }),
  // Wrong current passwords typed by somebody already signed in (password and
  // username changes, adding a passkey, creating an API token). Keyed by account, not address: whoever
  // holds a stolen session must not be able to use it to brute-force the
  // password it was opened with.
  reauthPerUser: createLimiter({ name: "reauthPerUser", windowMs: 15 * MINUTE, max: 5 }),
  // Usernames a wallet's manager tried to add that do not exist. Adding a
  // member has to say whether the name was found -- the members list would
  // say it a moment later anyway -- so the answer cannot be hidden; what can
  // be stopped is using the form to walk a list of names. Keyed by account.
  memberLookupPerUser: createLimiter({ name: "memberLookupPerUser", windowMs: 15 * MINUTE, max: 10 }),
  // Personal API tokens (tokens.js) that opened nothing -- malformed, unknown,
  // revoked -- from one address. A token cannot be guessed; this keeps a
  // script from making the inbox endpoints a free database lookup.
  tokenPerIp: createLimiter({ name: "tokenPerIp", windowMs: 15 * MINUTE, max: 30 }),
  // Test notifications asked for from the Profile page, per account: each one
  // makes the push services do work, and a script has no use for more.
  pushTestPerUser: createLimiter({ name: "pushTestPerUser", windowMs: 10 * MINUTE, max: 5 }),
};

module.exports = { createLimiter, tooMany, limits };
