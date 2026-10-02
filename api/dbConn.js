const { Pool, types } = require("pg");
const { AsyncLocalStorage } = require("node:async_hooks");
const Query = require("./models/Query");

// Money is numeric, never float, which the driver returns as a string
// because in general it may not fit a double. Ours do: an amount has two
// decimals and at most fourteen digits, a quantity or a price at most a few
// more, and a double carries fifteen significant digits exactly. So it becomes
// a number here, once, and every controller, sum and JSON answer goes on
// receiving the numbers it received when the columns were float. The totals a
// query adds up (sum over numeric is numeric) are exact before they get here.
types.setTypeParser(types.builtins.NUMERIC, parseFloat);

// ---------------------------------------------------------------------------
// Two pools, two roles
// ---------------------------------------------------------------------------
// adminPool connects as PGUSER: it owns the tables (and in the Postgres image
// it is also a superuser). Only migrations and bootstrap use it, because only
// they legitimately need to touch every user's rows.
//
// appPool connects as bussola_app, an ordinary role and therefore subject to
// Row Level Security. Everything that starts from an HTTP request goes here.
const adminPool = new Pool();

let appPool = null;

// The context of the request in flight: which user, which client.
// This is not a convenience. It is what lets the controllers stay as they were
// and, more importantly, what makes them fail closed when the context is
// missing.
const userContext = new AsyncLocalStorage();

const initAppPool = (password) => {
  appPool = new Pool({
    user: "bussola_app",
    password,
    // Host, port and database still come from the standard PG* variables.
  });
  return appPool;
};

// ---------------------------------------------------------------------------
// withTenant: the only way to touch a wallet's data
// ---------------------------------------------------------------------------
// Opens a transaction, sets app.user_id and app.wallet_id inside it, and runs
// fn. RLS does the rest: outside of here the data tables return nothing at all.
//
// Both settings matter, and neither is enough on its own. The policies resolve
// the caller's role by looking the pair up in wallet_members, so naming a
// wallet you are not a member of selects nothing and inserts nothing --
// setting the context is not the same as having the right.
//
// `write` says what the endpoint is for. When it is false the transaction is
// opened READ ONLY, so a read endpoint cannot write even by accident. It costs
// nothing and it is one more thing that cannot go wrong silently.
//
// The whole request becomes one transaction, which also closes the
// read-then-write races scattered through the controllers.
//
// `client` joins a transaction that is already open (transactionAuth below)
// instead of starting one: the settings are still transaction-local, and the
// caller's COMMIT or ROLLBACK decides for everything. Only a write can join --
// a READ ONLY transaction cannot be declared halfway through one.
const withTenant = async ({ userId, walletId, write = false, client: joined = null }, fn) => {
  if (!appPool) {
    throw new Error("appPool is not initialised: withTenant was called before startup.");
  }
  if (userId === undefined || userId === null || userId === "") {
    throw new Error("withTenant requires a userId.");
  }
  if (walletId === undefined || walletId === null || walletId === "") {
    throw new Error("withTenant requires a walletId.");
  }

  if (joined) {
    if (!write) throw new Error("withTenant can only join an open transaction to write.");
    await joined.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.wallet_id', $2, true)`,
      [String(userId), String(walletId)],
    );
    return userContext.run({ client: joined, userId, walletId, write }, () => fn(joined));
  }

  const client = await appPool.connect();
  try {
    // READ ONLY has to be part of BEGIN: by the time any other statement has
    // run, the transaction has taken its snapshot and SET TRANSACTION is
    // refused.
    await client.query(write ? "BEGIN" : "BEGIN READ ONLY");
    // SET LOCAL takes no parameters; set_config with is_local = true is the
    // parameterisable equivalent, and it clears itself when the transaction
    // ends.
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.wallet_id', $2, true)`,
      [String(userId), String(walletId)],
    );

    const result = await userContext.run({ client, userId, walletId, write }, () => fn(client));

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const currentClient = () => {
  const ctx = userContext.getStore();
  if (!ctx) {
    throw new Error(
      "Database access outside a user context: this query was issued without " +
        "withTenant() and would have run with no isolation at all. " +
        "See api/dbConn.js.",
    );
  }
  return ctx.client;
};

const currentUser = () => {
  const ctx = userContext.getStore();
  return ctx ? ctx.userId : null;
};

const currentWallet = () => {
  const ctx = userContext.getStore();
  return ctx ? ctx.walletId : null;
};

// Statement logging is for development, and it is opt-in. It used to be on
// unless DB_LOG said "off" -- and nothing in the compose file said it -- so a
// production instance printed every statement, text included, through stdout,
// which Node writes synchronously when it is a pipe: a page of the transaction
// list paid for its own log lines.
//
//   DB_LOG=on           every statement, with its duration and row count
//   (anything else)     only the slow ones, over DB_SLOW_MS (default 500 ms):
//                       a slow statement is worth a line in any environment
//
// Parameters are never printed: they are somebody's amounts and notes.
const LOG_ALL = ["on", "true", "1", "all"].includes(String(process.env.DB_LOG || "").toLowerCase());
const SLOW_MS = Number.parseInt(process.env.DB_SLOW_MS || "500", 10);

const logQuery = (text, start, rowCount) => {
  const duration = Date.now() - start;
  if (LOG_ALL) {
    console.log("executed query", { text, duration, rows: rowCount });
  } else if (Number.isFinite(SLOW_MS) && SLOW_MS > 0 && duration >= SLOW_MS) {
    console.warn("slow query", { text: String(text).replace(/\s+/g, " ").trim(), duration, rows: rowCount });
  }
};

module.exports = {
  adminPool,
  initAppPool,
  withTenant,
  currentUser,
  currentWallet,

  // The application pool with no user context. Only api/auth/ uses it, for
  // users, sessions, wallets and memberships, which by construction have no
  // RLS: login has to be able to look up a username before it knows who the
  // user is, and the wallet picker has to list what you can reach before any
  // wallet is in context.
  async queryAuth(text, params) {
    const start = Date.now();
    const res = await appPool.query(text, params);
    logQuery(text, start, res.rowCount);
    return res;
  },

  // Several auth statements that must happen together or not at all -- a new
  // account and its first wallet, a membership change checked against the
  // others. fn gets the client; COMMIT when it returns, ROLLBACK when it
  // throws. Same pool and same rules as queryAuth: api/auth/ only.
  async transactionAuth(fn) {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },

  // The two long-standing functions, now bound to the current transaction's
  // client: the controllers did not change, but they can no longer read
  // anyone else's data.
  async query(text, params) {
    const client = currentClient();
    const start = Date.now();
    // A failing statement is not logged here: the error goes up to the
    // caller, and the handler that answers the request logs it once.
    const res = await client.query(text, params);
    logQuery(text, start, res.rowCount);
    return res;
  },

  // We are already inside a transaction opened by withTenant, so this only
  // runs the statements in order. Unlike the previous version the results are
  // returned to the caller, which is what makes INSERT ... RETURNING usable.
  async queryTransaction(textParamsArray) {
    const client = currentClient();
    const results = [];
    for (const item of textParamsArray) {
      const q = new Query(item.text, item.params);
      const start = Date.now();
      const res = await client.query(q.text, q.params);
      logQuery(q.text, start, res.rowCount);
      results.push(res);
    }
    return results;
  },

  async closeAll() {
    await Promise.allSettled([adminPool.end(), appPool ? appPool.end() : null]);
  },
};
