const db = require("../dbConn");

// ---------------------------------------------------------------------------
// Wallets and memberships
// ---------------------------------------------------------------------------
// These two tables have no RLS, for the same reason users and sessions have
// none: the picker has to list what you can reach *before* any wallet is in
// context, so the filtering cannot come from a context that does not exist
// yet. Access to them is confined here and to auth/routes.js, through
// db.queryAuth(), and every function below takes the caller as an argument
// rather than trusting whatever id arrived in the URL.
//
// The RLS policies read wallet_members too (see migrations/001_schema.sql).
// What is decided here is who may *manage* a wallet; what its members may do
// with the data is decided by the database.

const ROLES = ["rw", "r"];
const validRole = (role) => ROLES.includes(role);

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------
// This list is the source of truth. frontend/src/config.js exports the same
// codes as `isoCurrencies` to fill the picker, and the two have to be kept in
// step by hand -- a copy in the browser is a convenience, never a rule, and a
// request naming a code that is not here is refused whatever the picker did or
// did not offer.
//
// Deliberately short. It is the currencies somebody self-hosting a personal
// finance application plausibly counts in, not ISO 4217 in full: a select with
// 180 rows in it is a worse answer than a select with ten, and adding one is a
// one-line change in two files rather than a migration.
const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "AUD", "CAD", "CNY", "HKD", "SEK"];

const cleanCurrency = (code) => String(code || "").trim().toUpperCase();
const validCurrency = (code) => CURRENCIES.includes(cleanCurrency(code));

const DEFAULT_CURRENCY = "EUR";

// A name to put on a wallet: short enough for a picker button, non-empty
// because the picker would otherwise show a blank row.
const NAME_MAX = 120;
const cleanName = (name) => String(name || "").trim().slice(0, NAME_MAX);

// Whether a row is the first wallet its creator ever got: the one onboarding
// handed them, which is not deletable. Written once, as SQL, and used both by
// the list (so the interface can leave the delete button out) and by the
// delete endpoint (so leaving it in would still not work).
//
// A wallet whose creator has since been deleted has created_by NULL -- the
// column is ON DELETE SET NULL -- and is nobody's first: NULL = NULL is never
// true, so the comparison below would misfire without the explicit guard.
const FIRST_WALLET_SQL = `(w.created_by IS NOT NULL
        AND w.id = (SELECT min(w2.id) FROM wallets w2 WHERE w2.created_by = w.created_by))`;

// The wallets somebody can open, with the role they have on each. Ordered by
// name because this is what fills the picker, and by id to break ties
// stably.
// `client`, here and in create(), is a transaction the caller already opened
// (db.transactionAuth): statements that have to succeed or fail together run
// on it. Without one they run on their own, as they always did.
const runner = (client) => (client ? (text, params) => client.query(text, params) : db.queryAuth);

const listForUser = async (userId, client = null) => {
  const { rows } = await runner(client)(
    `SELECT w.id, w.name, w.currency, m.role, w.created_by,
            (w.created_by = $1) AS mine,
            ${FIRST_WALLET_SQL} AS first_wallet,
            (SELECT count(*)::int FROM wallet_members mm WHERE mm.wallet_id = w.id) AS members
       FROM wallet_members m
       JOIN wallets w ON w.id = m.wallet_id
      WHERE m.user_id = $1
      ORDER BY w.name, w.id`,
    [userId],
  );
  return rows;
};

// The same question about a single wallet. Asked again at delete time rather
// than trusted from whatever the interface last drew.
const isFirst = async (walletId) => {
  const { rows } = await db.queryAuth(
    `SELECT ${FIRST_WALLET_SQL} AS first_wallet FROM wallets w WHERE w.id = $1`,
    [walletId],
  );
  return rows[0] ? rows[0].first_wallet : false;
};

// The caller's role on one wallet, or null when they are not a member. This is
// the same question the RLS policies ask; asking it here as well is what lets
// the API answer 403 instead of letting a policy violation surface as a 500.
const roleFor = async (walletId, userId) => {
  const { rows } = await db.queryAuth(
    "SELECT role FROM wallet_members WHERE wallet_id = $1 AND user_id = $2",
    [walletId, userId],
  );
  return rows[0] ? rows[0].role : null;
};

const byId = async (walletId) => {
  const { rows } = await db.queryAuth(
    "SELECT id, name, currency, created_by FROM wallets WHERE id = $1",
    [walletId],
  );
  return rows[0] || null;
};

// Who may add, remove and re-rank members: the instance administrator, and
// whoever created the wallet. A wallet whose creator has since been deleted
// (created_by is SET NULL) is left to the administrator.
const canManage = async (user, walletId) => {
  if (!user) return false;
  if (user.is_admin) return true;
  const wallet = await byId(walletId);
  return !!wallet && wallet.created_by === user.id;
};

// Creating a wallet and joining it are one act: a wallet with no members is
// unreachable by anyone, including the person who just made it.
//
// The currency is optional and falls back to the column default. Somebody
// making their second wallet is handed the currency of the one they were
// looking at -- routes.js passes it -- because a person who counts in Swiss
// francs is unlikely to start counting in euro halfway through the afternoon.
// The very first wallet of an account has no such context and gets EUR, which
// the owner can change on the profile page.
const create = async (name, userId, currency, client = null) => {
  const run = runner(client);
  const { rows } = await run(
    `INSERT INTO wallets (id, name, created_by, currency)
     VALUES (nextval('seq_wallets'), $1, $2, $3)
     RETURNING id, name, currency, created_by`,
    [cleanName(name), userId, validCurrency(currency) ? cleanCurrency(currency) : DEFAULT_CURRENCY],
  );
  const wallet = rows[0];

  await run(
    "INSERT INTO wallet_members (wallet_id, user_id, role) VALUES ($1, $2, 'rw')",
    [wallet.id, userId],
  );

  return wallet;
};

const rename = async (walletId, name) => {
  const { rows } = await db.queryAuth(
    "UPDATE wallets SET name = $2 WHERE id = $1 RETURNING id, name, currency, created_by",
    [walletId, cleanName(name)],
  );
  return rows[0] || null;
};

// Changing the unit every member of the wallet reads its numbers in. It
// converts nothing: 1000 stays 1000 and only the symbol beside it changes,
// which is the honest behaviour for an application that has never known an
// exchange rate. The caller has already been through requireManager -- the
// same rule that guards the rename -- and the code has already been checked
// against CURRENCIES; the CHECK constraint on the column is the second line.
const setCurrency = async (walletId, currency) => {
  const { rows } = await db.queryAuth(
    "UPDATE wallets SET currency = $2 WHERE id = $1 RETURNING id, name, currency, created_by",
    [walletId, cleanCurrency(currency)],
  );
  return rows[0] || null;
};

// Deleting a wallet deletes its data: the foreign keys cascade from wallets to
// all four data tables. The caller has to have meant it.
const remove = (walletId) => db.queryAuth("DELETE FROM wallets WHERE id = $1", [walletId]);

const members = async (walletId) => {
  const { rows } = await db.queryAuth(
    `SELECT u.id, u.username, u.active, m.role, m.created_at,
            (w.created_by = u.id) AS creator
       FROM wallet_members m
       JOIN users   u ON u.id = m.user_id
       JOIN wallets w ON w.id = m.wallet_id
      WHERE m.wallet_id = $1
      ORDER BY u.username`,
    [walletId],
  );
  return rows;
};

// ---------------------------------------------------------------------------
// Changing who is in a wallet
// ---------------------------------------------------------------------------
// One rule binds all three changes below: a wallet keeps at least one member
// who can write. Demoting or removing the last one would leave data nobody can
// change and nobody can share -- still there, and frozen.
//
// The rule is checked and applied inside one transaction, with the wallet row
// locked first. Checking in one statement and writing in the next let two
// demotions pass together, each counting the other as the writer who would
// remain; the lock makes the second one wait and then count again. And it is
// checked on every path, the add-member upsert included, which used to be able
// to turn the only writer into a reader with no check at all.
//
// Each returns a status the route turns into an answer:
//   "OK", "LAST_WRITER", "NOT_A_MEMBER", "USER_NOT_FOUND", "WALLET_NOT_FOUND".

// Locks the wallet and answers whether moving `userId` to `nextRole` (null:
// out of the wallet) would leave it without a writer. Also returns the current
// role, which the callers need anyway.
const lockAndCheck = async (client, walletId, userId, nextRole) => {
  const { rows: wallet } = await client.query("SELECT id FROM wallets WHERE id = $1 FOR UPDATE", [
    walletId,
  ]);
  if (!wallet[0]) return { status: "WALLET_NOT_FOUND" };

  const { rows: mine } = await client.query(
    "SELECT role FROM wallet_members WHERE wallet_id = $1 AND user_id = $2",
    [walletId, userId],
  );
  const current = mine[0] ? mine[0].role : null;

  if (current === "rw" && nextRole !== "rw") {
    const { rows: others } = await client.query(
      `SELECT count(*)::int AS n FROM wallet_members
        WHERE wallet_id = $1 AND user_id <> $2 AND role = 'rw'`,
      [walletId, userId],
    );
    if (others[0].n === 0) return { status: "LAST_WRITER", current };
  }
  return { status: "OK", current };
};

// By username, because that is what one person knows about another. There is
// no invitation to accept: on a self-hosted instance the people involved have
// already agreed offline, and a mailbox to send an invitation to does not
// exist. Somebody already in the wallet gets the new role instead -- which is
// exactly the path that has to respect the last-writer rule too.
const addMember = (walletId, username, role) =>
  db.transactionAuth(async (client) => {
    const { rows } = await client.query(
      "SELECT id, username FROM users WHERE lower(username) = lower($1)",
      [String(username || "")],
    );
    if (!rows[0]) return { status: "USER_NOT_FOUND" };

    const check = await lockAndCheck(client, walletId, rows[0].id, role);
    if (check.status !== "OK") return check;

    await client.query(
      `INSERT INTO wallet_members (wallet_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (wallet_id, user_id) DO UPDATE SET role = excluded.role`,
      [walletId, rows[0].id, role],
    );
    return { status: "OK", user: rows[0] };
  });

const setRole = (walletId, userId, role) =>
  db.transactionAuth(async (client) => {
    const check = await lockAndCheck(client, walletId, userId, role);
    if (check.status !== "OK") return check.status;
    if (!check.current) return "NOT_A_MEMBER";

    await client.query("UPDATE wallet_members SET role = $3 WHERE wallet_id = $1 AND user_id = $2", [
      walletId,
      userId,
      role,
    ]);
    return "OK";
  });

// Removing yourself is allowed -- leaving a wallet somebody else shared with
// you is a normal thing to want -- unless you are the last one who can write.
const removeMember = (walletId, userId) =>
  db.transactionAuth(async (client) => {
    const check = await lockAndCheck(client, walletId, userId, null);
    if (check.status !== "OK") return check.status;
    if (!check.current) return "NOT_A_MEMBER";

    await client.query("DELETE FROM wallet_members WHERE wallet_id = $1 AND user_id = $2", [
      walletId,
      userId,
    ]);
    return "OK";
  });

const rwCount = async (walletId) => {
  const { rows } = await db.queryAuth(
    "SELECT count(*)::int AS n FROM wallet_members WHERE wallet_id = $1 AND role = 'rw'",
    [walletId],
  );
  return rows[0].n;
};

// Everyone who was looking at this wallet stops looking at it. The session
// survives -- only the choice is undone -- so they land on the picker instead
// of the login screen.
const clearFromSessions = (walletId) =>
  db.queryAuth("UPDATE sessions SET wallet_id = NULL WHERE wallet_id = $1", [walletId]);

const clearFromUserSessions = (walletId, userId) =>
  db.queryAuth("UPDATE sessions SET wallet_id = NULL WHERE wallet_id = $1 AND user_id = $2", [
    walletId,
    userId,
  ]);

// id -> username, for the authors the transaction list shows (created_by,
// updated_by). A deleted account is simply absent: its rows already hold NULL.
const usernames = async (ids) => {
  if (!ids.length) return new Map();
  const { rows } = await db.queryAuth("SELECT id, username FROM users WHERE id = ANY($1::int[])", [ids]);
  return new Map(rows.map((r) => [r.id, r.username]));
};

// Every wallet on the instance. For the administration screen only.
const listAll = async () => {
  const { rows } = await db.queryAuth(
    `SELECT w.id, w.name, w.created_by, u.username AS created_by_username,
            (SELECT count(*)::int FROM wallet_members m WHERE m.wallet_id = w.id) AS members
       FROM wallets w
       LEFT JOIN users u ON u.id = w.created_by
      ORDER BY w.name, w.id`,
  );
  return rows;
};

// Every wallet with the active members who may write to it, lowest id first.
// For background work that has to act inside a wallet as somebody (the inbox
// reader resuming after a restart).
const writersByWallet = async () => {
  const { rows } = await db.queryAuth(
    `SELECT m.wallet_id AS id, array_agg(m.user_id ORDER BY m.user_id) AS writers
       FROM wallet_members m
       JOIN users u ON u.id = m.user_id AND u.active
      WHERE m.role = 'rw'
      GROUP BY m.wallet_id
      ORDER BY m.wallet_id`,
  );
  return rows;
};

module.exports = {
  writersByWallet,
  ROLES,
  validRole,
  CURRENCIES,
  DEFAULT_CURRENCY,
  cleanCurrency,
  validCurrency,
  cleanName,
  listForUser,
  listAll,
  isFirst,
  roleFor,
  byId,
  canManage,
  create,
  rename,
  setCurrency,
  remove,
  members,
  addMember,
  setRole,
  removeMember,
  rwCount,
  clearFromSessions,
  clearFromUserSessions,
  usernames,
};
