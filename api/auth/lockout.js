const db = require("../dbConn");

// ---------------------------------------------------------------------------
// The account lock
// ---------------------------------------------------------------------------
// Five wrong passwords in a row lock the account for a while.
// Not for good: a permanent lock is something anyone who knows a username can
// inflict with five requests, on the only administrator as easily as on
// anybody else. A lock that lifts by itself still makes guessing hopeless --
// five tries per quarter of an hour, then per half hour, then per hour, up to
// five a day -- without handing strangers an off switch.
//
// Three rules, shared by the password and the passkey sign-in:
//
//   - Only a wrong *password* counts. A failed passkey never does (nobody
//     guesses an ECDSA signature, and counting them would let anyone lock an
//     account without even knowing its username).
//   - Whether the account is locked is said only after a correct password or
//     a valid passkey. Before that every refusal is the same "wrong username
//     or password", so the lock cannot be used to find out who has an account.
//   - The lock stops new sign-ins, not sessions already open: the owner is not
//     thrown out of every device because somebody else typed badly.
//
// users.active stays what an administrator sets, and is enforced as before.

// Wrong passwords in a row before the account locks.
const MAX_FAILED_LOGINS = 5;

// The first lock's length. Configurable mostly so a test instance can use a
// few seconds instead of waiting a quarter of an hour; each lock after that
// doubles, up to a day.
const BASE_SECONDS = Math.max(1, Number(process.env.BUSSOLA_LOCKOUT_SECONDS) || 15 * 60);
const MAX_SECONDS = Math.max(24 * 60 * 60, BASE_SECONDS);
// A day after the last lock ended, the doubling starts over.
const RESET_AFTER_SECONDS = 24 * 60 * 60;

// The user row plus what the lock means right now, computed by the database
// so that the API's clock and Postgres' cannot disagree about it.
const USER_WITH_LOCK = `
  SELECT *,
         (locked_until IS NOT NULL AND locked_until > now()) AS locked_now,
         CASE WHEN locked_until > now()
              THEN ceil(extract(epoch FROM locked_until - now()))::int
              ELSE 0 END AS lock_remaining
    FROM users`;

// Deliberately not filtered by `active`: a disabled account has to be
// recognisable, otherwise the person who owns it is told their password is
// wrong forever, with no hint of why.
const findByUsername = async (username) => {
  const { rows } = await db.queryAuth(`${USER_WITH_LOCK} WHERE lower(username) = lower($1)`, [
    String(username || ""),
  ]);
  return rows[0] || null;
};

const findById = async (id) => {
  const { rows } = await db.queryAuth(`${USER_WITH_LOCK} WHERE id = $1`, [id]);
  return rows[0] || null;
};

// One wrong password against an account. A single statement, so two guesses
// arriving together cannot both read four and both write five.
//
// Nothing is counted while the account is disabled or already locked: there
// is nothing more to take away, and counting on would only make the next lock
// longer for the owner. Every SET expression reads the row as it was, which is
// what lets the fifth failure both reset the count and set the lock.
const recordWrongPassword = async (user) => {
  if (!user || !user.active) return null;

  const { rows } = await db.queryAuth(
    `UPDATE users
        SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
            lockouts = CASE
                         WHEN failed_logins + 1 < $2 THEN lockouts
                         WHEN locked_until < now() - make_interval(secs => $5) THEN 1
                         ELSE lockouts + 1
                       END,
            locked_until = CASE
                             WHEN failed_logins + 1 < $2 THEN locked_until
                             ELSE now() + make_interval(secs => least(
                                    $3 * power(2, CASE
                                                    WHEN locked_until < now() - make_interval(secs => $5) THEN 0
                                                    ELSE least(lockouts, 20)
                                                  END),
                                    $4))
                           END,
            locked_at = CASE WHEN failed_logins + 1 >= $2 THEN now() ELSE locked_at END
      WHERE id = $1
        AND active
        AND (locked_until IS NULL OR locked_until <= now())
  RETURNING username, lockouts,
            (locked_until IS NOT NULL AND locked_until > now()) AS locked,
            CASE WHEN locked_until > now()
                 THEN ceil(extract(epoch FROM locked_until - now()))::int
                 ELSE 0 END AS seconds`,
    [user.id, MAX_FAILED_LOGINS, BASE_SECONDS, MAX_SECONDS, RESET_AFTER_SECONDS],
  );

  const after = rows[0];
  if (after && after.locked) {
    console.warn(
      `[auth] account "${after.username}" locked for ${after.seconds}s after ` +
        `${MAX_FAILED_LOGINS} wrong passwords (lock #${after.lockouts} in a row). ` +
        `It opens again by itself; an admin can unlock it sooner, or run: ` +
        `node api/scripts/unlock.js ${after.username}`,
    );
  }
  return after || null;
};

// Called only once the identity has been proven -- the password was right, or
// the passkey's signature was. Answers the refusal and returns true when the
// account may not sign in; returns false when it may.
const refuseIfLocked = (res, user) => {
  if (!user.active) {
    res.status(403).json({
      code: "ACCOUNT_DISABLED",
      error: "This account is disabled. An administrator has to re-enable it.",
    });
    return true;
  }
  if (user.locked_now) {
    const seconds = Math.max(1, Number(user.lock_remaining) || BASE_SECONDS);
    res.set("Retry-After", String(seconds));
    res.status(403).json({
      code: "ACCOUNT_LOCKED",
      error:
        "Too many wrong passwords: this account is locked for now. " +
        `Try again in ${Math.ceil(seconds / 60)} minutes, or ask an administrator to unlock it.`,
      retryAfter: seconds,
    });
    return true;
  }
  return false;
};

// What a successful sign-in, the admin's unlock and scripts/unlock.js all
// write: no failures, no lock, the doubling started over.
const CLEARED = "failed_logins = 0, lockouts = 0, locked_until = NULL";

module.exports = {
  MAX_FAILED_LOGINS,
  BASE_SECONDS,
  MAX_SECONDS,
  CLEARED,
  findByUsername,
  findById,
  recordWrongPassword,
  refuseIfLocked,
};
