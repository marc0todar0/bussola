// ---------------------------------------------------------------------------
// "Your name as your banks write it"
// ---------------------------------------------------------------------------
// A personal setting (users.bank_names, migration 003): one to five names,
// "Marco Todaro, TODARO MARCO". The notification reader is told them, so that
// "Sent €500 to Marco Todaro (Fineco)" is a transfer between the person's own
// accounts rather than a payment to a stranger.
//
// users is an identity table: no RLS, reached only from api/auth/ through
// db.queryAuth(), and every statement names the user -- the session's own,
// never one from the request.
const db = require("../dbConn");
const { requireAuth } = require("./middleware");

const NAMES_MAX = 5;
const NAME_MAX = 80;

// An array of strings or one comma-separated string; trimmed, empty ones
// dropped, duplicates (whatever the case) once. null when it breaks a limit.
const parseNames = (value) => {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!list || list.some((n) => typeof n !== "string")) return null;
  const seen = new Map();
  for (const raw of list) {
    const name = raw.replace(/\s+/g, " ").trim();
    if (!name) continue;
    if (name.length > NAME_MAX) return null;
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  const names = [...seen.values()];
  return names.length <= NAMES_MAX ? names : null;
};

// What the notification reader needs of the identity tables: the sender's
// names and the wallet's currency. The membership is not checked here -- the
// caller runs inside withTenant as that user, where RLS does.
const readerContext = async (userId, walletId) => {
  const { rows } = await db.queryAuth(
    `SELECT u.bank_names, w.currency
       FROM users u, wallets w
      WHERE u.id = $1 AND w.id = $2`,
    [userId, walletId],
  );
  const row = rows[0] || {};
  return {
    bankNames: row.bank_names || [],
    currency: String(row.currency || "EUR").trim().toUpperCase(),
  };
};

// POST /api/auth/bank-names { names: ["Marco Todaro", "TODARO MARCO"] }
// (or "Marco Todaro, TODARO MARCO"). An empty list clears the setting.
const bankNamesRoute = (fail) => [
  requireAuth,
  async (req, res) => {
    const names = parseNames((req.body || {}).names);
    if (!names) {
      return fail(
        res,
        400,
        "INVALID_BANK_NAMES",
        `At most ${NAMES_MAX} names, each of at most ${NAME_MAX} characters`,
      );
    }
    try {
      await db.queryAuth("UPDATE users SET bank_names = $1 WHERE id = $2", [names, req.user.id]);
      res.json({ bankNames: names });
    } catch (error) {
      console.error("Could not save the bank names:", error.message);
      fail(res, 500, "BANK_NAMES_SAVE_FAILED", "Could not save the names");
    }
  },
];

module.exports = { parseNames, readerContext, bankNamesRoute, NAMES_MAX, NAME_MAX };
