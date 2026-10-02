// SQL migration runner.
//
// Runs at API startup, before the server accepts requests: a freshly cloned
// instance goes from empty database to ready schema with no manual restore.
//
// Conventions:
//   - one file per migration in api/migrations/, named `NNN_description.sql`
//   - a released migration is never edited: add a new one instead
//   - each file runs inside a transaction, so it must not contain BEGIN/COMMIT
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

// A Postgres advisory lock: when several API replicas start together, one
// applies the migrations and the others wait.
const LOCK_ID = 4771294; // arbitrary but stable: it means "Bussola's migrations"

const listMigrations = () =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexicographic, but the fixed-width numeric prefix makes it chronological

const createTrackingTable = (client) =>
  client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

// Before the first public release the schema was built by seventeen
// migrations, 001_baseline.sql to 017_unique_account_names.sql, since folded
// into 001_schema.sql. A database that ran all seventeen already has exactly
// the schema 001_schema.sql creates, so its history is rewritten to say so --
// the seventeen rows replaced by one -- and nothing is run. One that stopped
// halfway has a schema no single file here can finish: it has to go through
// the last release that still carried the old files first.
const SQUASHED = [
  "001_baseline.sql",
  "002_multiutente.sql",
  "003_english_schema.sql",
  "004_fix_icon_names.sql",
  "005_username_login.sql",
  "006_account_lockout.sql",
  "007_wallets.sql",
  "008_wallet_currency.sql",
  "009_passkeys.sql",
  "010_temporary_lockout.sql",
  "011_performance.sql",
  "012_money_numeric.sql",
  "013_wallet_holding_types.sql",
  "014_throttles.sql",
  "015_drop_user_name.sql",
  "016_transaction_updated_by.sql",
  "017_unique_account_names.sql",
];
const SQUASHED_INTO = "001_schema.sql";

const tooOld = (at) =>
  new Error(
    `this database is at ${at}; upgrade to the last release before 0.1 first, then to this one.`,
  );

const squashHistory = async (client) => {
  const { rows } = await client.query("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.version));

  // A schema with no history at all predates the migrations themselves (it
  // still has its Italian table names). Running 001_schema.sql there would
  // build an empty English schema beside the real data.
  if (applied.size === 0) {
    const { rows: legacy } = await client.query(
      "SELECT to_regclass('public.movimenti') IS NOT NULL AS present",
    );
    if (legacy[0].present) throw tooOld("a version from before migrations existed");
    return;
  }

  const old = SQUASHED.filter((v) => applied.has(v));
  if (old.length === 0) return;
  if (!applied.has(SQUASHED[SQUASHED.length - 1])) throw tooOld(old[old.length - 1]);

  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM schema_migrations WHERE version = ANY($1)", [SQUASHED]);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [SQUASHED_INTO]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
  console.log(
    `[migrate] ${old.length} pre-release migrations recorded as ${SQUASHED_INTO}; nothing re-applied.`,
  );
};

const apply = async (client, version) => {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, version), "utf8");
  console.log(`[migrate] applying ${version}...`);
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    await client.query("COMMIT");
    console.log(`[migrate] ${version} applied.`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw new Error(`migration ${version} failed: ${e.message}`);
  }
};

// Postgres may start accepting connections a few seconds after the API does
// (in development the containers come up in parallel). Waiting beats exiting.
//
// But the retry is there to cover startup time, not to insist on a refusal. If
// the server answers and says no -- wrong credentials, missing database --
// retrying fifteen times buries the real error under thirty seconds of
// "database not ready". Those cases stop the boot immediately.
const TRANSIENT = new Set([
  "ECONNREFUSED", // the port is not open yet
  "ENOTFOUND", // the service name does not resolve yet
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "57P03", // the database system is starting up
]);

// Postgres does not distinguish "no such role" from "wrong password": both
// reach the client as 28P01, deliberately, so that nobody can enumerate who
// has an account. The real reason stays in the server log, so the hint has to
// cover both cases.
const HINTS = {
  "28P01":
    "either PGUSER does not exist on this database or PGPASSWORD does not " +
    "match (Postgres will not say which). Remember that POSTGRES_USER only " +
    "applies when the volume is created: on an already initialised volume the " +
    "user stays the one it was created with. The Postgres log (docker logs) " +
    "says which of the two it is.",
  "3D000":
    "the database named by PGDATABASE does not exist. POSTGRES_DB, too, only " +
    "applies when the volume is created.",
  "28000": "the connection was refused by Postgres' configuration (pg_hba.conf).",
};

const waitForDatabase = async (pool, attempts = 15, waitMs = 2000) => {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (e) {
      if (!TRANSIENT.has(e.code)) {
        const hint = HINTS[e.code];
        throw new Error(
          `the database is reachable but refused the connection: ${e.message}` +
            (hint ? `\n         ${hint}` : ""),
        );
      }
      if (i === attempts) throw new Error(`database unreachable: ${e.message}`);
      console.log(`[migrate] database not ready (${i}/${attempts}), retrying...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
};

const runMigrations = async (pool) => {
  await waitForDatabase(pool);

  const versions = listMigrations();
  if (versions.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await createTrackingTable(client);
    await squashHistory(client);

    const { rows } = await client.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    const pending = versions.filter((v) => !applied.has(v));

    if (pending.length === 0) {
      console.log(`[migrate] schema up to date (${versions.length} migrations).`);
      return;
    }
    for (const version of pending) {
      await apply(client, version);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
};

// ---------------------------------------------------------------------------
// The application role
// ---------------------------------------------------------------------------
// The API does not connect as PGUSER: that role owns the tables (and in the
// Postgres image it is a superuser too), and superusers bypass RLS. It
// connects as bussola_app, created by 001_schema.sql.
//
// The password is generated here on every boot and kept in memory: one fewer
// environment variable for whoever installs this. Anyone who needs a stable
// password (multiple API replicas, external access) sets
// BUSSOLA_DB_APP_PASSWORD.
const APP_ROLE = "bussola_app";

const configureAppRole = async (pool) => {
  const password =
    process.env.BUSSOLA_DB_APP_PASSWORD || crypto.randomBytes(24).toString("base64url");

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );
    if (rows.length === 0) {
      throw new Error(`role ${APP_ROLE} does not exist: 001_schema.sql has not been applied.`);
    }
    // If the role could bypass RLS, isolation between users would be a fiction.
    if (rows[0].rolsuper || rows[0].rolbypassrls) {
      throw new Error(
        `role ${APP_ROLE} is a superuser or has BYPASSRLS: with those privileges ` +
          `Row Level Security filters nothing. Remove them before starting.`,
      );
    }

    // ALTER ROLE takes no parameters, so Postgres composes the statement and
    // escaping the password is not our problem.
    const {
      rows: [{ stmt }],
    } = await client.query(
      "SELECT format('ALTER ROLE %I WITH PASSWORD %L', $1::text, $2::text) AS stmt",
      [APP_ROLE, password],
    );
    await client.query(stmt);
  } finally {
    client.release();
  }

  return password;
};

// ---------------------------------------------------------------------------
// Check that isolation is genuinely on
// ---------------------------------------------------------------------------
// RLS that does not filter gives no signal at all: the queries work, the data
// shows up, and the leak surfaces when it is too late. So we check it on every
// boot, and if it does not filter the API does not start.
const verifyIsolation = async (appPool) => {
  const tables = ["accounts", "transactions", "holdings", "portfolio_snapshots", "inbox_items"];
  const client = await appPool.connect();
  try {
    // The policies decide through this function: with no context it must say
    // "not a member", and if it ever said anything else every check below
    // would pass for the wrong reason.
    const { rows: role } = await client.query("SELECT app_wallet_role() AS role");
    if (role[0].role !== null) {
      throw new Error(
        `app_wallet_role() returns "${role[0].role}" with no context and should return ` +
          `nothing: the wallet policies would let anyone in. Startup aborted.`,
      );
    }

    for (const t of tables) {
      // No app.wallet_id is set: the policy must return zero rows.
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      if (rows[0].n !== 0) {
        throw new Error(
          `isolation is not active on "${t}": a connection with no wallet context ` +
            `sees ${rows[0].n} rows and should see none. Startup aborted.`,
        );
      }
    }
    // holding_types cannot join the list above: its seeded rows belong to
    // nobody and are visible with no context, by design. The rows a wallet
    // invented must not be.
    const { rows: custom } = await client.query(
      "SELECT count(*)::int AS n FROM holding_types WHERE wallet_id IS NOT NULL",
    );
    if (custom[0].n !== 0) {
      throw new Error(
        `isolation is not active on "holding_types": a connection with no wallet ` +
          `context sees ${custom[0].n} wallet-owned types and should see none. Startup aborted.`,
      );
    }
    console.log(`[migrate] RLS isolation verified on ${tables.length + 1} tables.`);
  } finally {
    client.release();
  }
};

module.exports = { runMigrations, waitForDatabase, configureAppRole, verifyIsolation };
