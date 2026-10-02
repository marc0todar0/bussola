// ---------------------------------------------------------------------------
// The demo's API
// ---------------------------------------------------------------------------
// The public demo is the frontend alone, on a static host: there is no server
// to sign in to and nowhere to keep anybody's data. fetchAuth and session.js
// hand their requests here instead (browser.js) when the bundle was built with
// VITE_DEMO=1, and this answers them the way the API would -- same paths, same
// shapes, same codes -- from an in-memory copy of the invented dataset. What a
// visitor writes changes that copy and is gone at the next reload.
//
// One person, "demo", read-write on one wallet, managing nothing and
// administering nothing: every screen of the application works except the ones
// that change who has access or move data in or out, which answer 403
// DEMO_DISABLED.
//
// createServer() is plain JavaScript, so scripts/demo-check.mjs runs it in Node
// against the same dataset as a real API and fails on any answer that differs.
import { DemoError, createState } from "./state.js";
import * as ledger from "./ledger.js";
import * as reports from "./reports.js";
import * as inbox from "./inbox.js";

// The two endpoints a phone posts to with a personal token. The demo has no
// tokens, so whatever is sent is not one.
const noToken = () => new DemoError(401, "TOKEN_INVALID", "The token is not valid");

const disabled = () => new DemoError(403, "DEMO_DISABLED", "Not available in the demo");

const me = (db) => ({
  id: db.user.id,
  username: db.user.username,
  email: null,
  locale: db.locale,
  currency: db.wallet.currency,
  isAdmin: false,
  wallet: { id: db.wallet.id, name: db.wallet.name, role: "rw", currency: db.wallet.currency, canManage: false },
  // No quote service, the same as an instance without BUSSOLA_QUOTES_URL: the refresh
  // buttons are drawn disabled, and the endpoints answer QUOTES_DISABLED.
  quotes: false,
  quoteSources: [],
  // No model reading bank notifications either (no BUSSOLA_AI_URL), and no
  // names for it; setting them falls through to DEMO_DISABLED with the rest
  // of /auth.
  ai: false,
  aiCloud: false,
  bankNames: [],
});

const LOCALES = ["en", "it", "fr", "de", "es", "zh"];

// [method, path pattern, handler({ db, params, query, body })]. First match
// wins, so a literal path comes before the pattern it would also match.
const ROUTES = [
  ["GET", /^\/health$/, () => ({ status: "ok" })],

  // --- auth: who is here, and the settings that are not access ------------
  ["GET", /^\/auth\/me$/, ({ db }) => me(db)],
  ["GET", /^\/auth\/status$/, () => ({ signupOpen: false, passkeys: false, passkeyOrigin: null, push: false, pushPublicKey: null })],
  // Any username and password: there is only the one account, and signing out
  // and in again should not leave anybody stuck on the login screen.
  ["POST", /^\/auth\/login$/, ({ db }) => me(db)],
  ["POST", /^\/auth\/logout$/, () => ({ ok: true })],
  [
    "POST",
    /^\/auth\/locale$/,
    ({ db, body }) => {
      if (!LOCALES.includes(body.locale)) throw new DemoError(400, "INVALID_LOCALE", "Invalid language");
      db.locale = body.locale;
      return { locale: db.locale };
    },
  ],
  [
    "GET",
    /^\/auth\/wallets$/,
    ({ db }) => [
      { ...db.wallet, role: "rw", created_by: db.user.id, mine: true, first_wallet: true, members: 1 },
    ],
  ],
  ["POST", /^\/auth\/wallet$/, ({ db }) => me(db).wallet],
  ["GET", /^\/auth\/passkeys$/, () => []],
  // Personal API tokens: none, and none can be made (the POST and DELETE fall
  // through to DEMO_DISABLED with the rest of /auth).
  ["GET", /^\/auth\/tokens$/, () => []],

  // --- accounts and categories ---------------------------------------------
  ["GET", /^\/accounts$/, ({ db, query }) => ledger.getAccounts(db, query)],
  ["POST", /^\/accounts$/, ({ db, body }) => ledger.createAccount(db, body, db.user)],
  [
    "POST",
    /^\/accounts\/(?<id>[^/]+)\/archive$/,
    ({ db, params, body }) => ledger.setArchived(db, params.id, body.archived === true, true),
  ],
  ["POST", /^\/accounts\/(?<id>[^/]+)\/holdings\/refresh$/, ({ db, params }) => reports.refreshAccount(db, params.id)],
  ["GET", /^\/accounts\/(?<id>[^/]+)\/holdings$/, ({ db, params }) => reports.getHoldings(db, params.id)],
  ["POST", /^\/accounts\/(?<id>[^/]+)\/holdings$/, ({ db, params, body }) => reports.createHolding(db, params.id, body)],
  ["POST", /^\/accounts\/(?<id>[^/]+)$/, ({ db, params, body }) => ledger.updateAccount(db, params.id, body)],
  ["DELETE", /^\/accounts\/(?<id>[^/]+)$/, ({ db, params }) => ledger.deleteAccountOrCategory(db, params.id, "account")],

  ["GET", /^\/categories\/(?<kind>[^/]+)$/, ({ db, params, query }) => ledger.getCategories(db, params.kind, query)],
  ["POST", /^\/categories$/, ({ db, body }) => ledger.createCategory(db, body, db.user)],
  [
    "POST",
    /^\/categories\/(?<id>[^/]+)\/archive$/,
    ({ db, params, body }) => ledger.setArchived(db, params.id, body.archived === true, false),
  ],
  ["POST", /^\/categories\/(?<id>[^/]+)$/, ({ db, params, body }) => ledger.updateCategory(db, params.id, body)],
  [
    "DELETE",
    /^\/categories\/(?<id>[^/]+)$/,
    ({ db, params }) => ledger.deleteAccountOrCategory(db, params.id, "category"),
  ],

  // --- lookups and holdings -------------------------------------------------
  ["GET", /^\/pillars$/, ({ db }) => reports.getPillars(db)],
  ["GET", /^\/holding-types$/, ({ db }) => reports.getHoldingTypes(db)],
  ["POST", /^\/holding-types$/, ({ db, body }) => reports.createHoldingType(db, body)],
  ["DELETE", /^\/holding-types\/(?<id>[^/]+)$/, ({ db, params }) => reports.deleteHoldingType(db, params.id)],
  ["GET", /^\/holdings\/distinct\/(?<field>[^/]+)$/, ({ db, params }) => reports.getDistinctValues(db, params.field)],
  ["POST", /^\/holdings\/refresh-all$/, ({ db }) => reports.refreshAll(db)],
  ["POST", /^\/holdings\/(?<hid>[^/]+)\/refresh$/, ({ db, params }) => reports.refreshHolding(db, params.hid)],
  ["POST", /^\/holdings\/(?<hid>[^/]+)$/, ({ db, params, body }) => reports.updateHolding(db, params.hid, body)],
  ["DELETE", /^\/holdings\/(?<hid>[^/]+)$/, ({ db, params }) => reports.deleteHolding(db, params.hid)],

  // --- transactions -----------------------------------------------------------
  ["GET", /^\/transactions$/, ({ db, query }) => ledger.getTransactions(db, query)],
  ["GET", /^\/transactions\/form-data$/, ({ db }) => ledger.getNewTransactionData(db)],
  ["POST", /^\/transactions$/, ({ db, body }) => ledger.createTransaction(db, body, db.user)],
  ["POST", /^\/transactions\/(?<id>[^/]+)$/, ({ db, params, body }) => ledger.updateTransaction(db, params.id, body, db.user)],
  ["DELETE", /^\/transactions\/(?<id>[^/]+)$/, ({ db, params }) => ledger.deleteTransaction(db, params.id)],

  // --- inbox ------------------------------------------------------------------
  ["POST", /^\/inbox$/, () => {
    throw noToken();
  }],
  ["GET", /^\/inbox\/context$/, () => {
    throw noToken();
  }],
  ["GET", /^\/inbox$/, ({ db }) => inbox.getPending(db)],
  ["POST", /^\/inbox\/(?<id>[^/]+)\/accept$/, ({ db, params, body }) => inbox.accept(db, params.id, body)],
  ["POST", /^\/inbox\/(?<id>[^/]+)\/dismiss$/, ({ db, params }) => inbox.dismiss(db, params.id)],

  // --- summary ----------------------------------------------------------------
  ["GET", /^\/summary$/, ({ db, query }) => reports.getChartData(db, query)],
  ["GET", /^\/summary\/month$/, ({ db, query }) => ({ sums: reports.getMonthlyData(db, query) })],
  ["GET", /^\/summary\/year$/, ({ db, query }) => reports.getYearlyData(db, query)],

  // --- portfolio --------------------------------------------------------------
  ["GET", /^\/portfolio\/allocation$/, ({ db }) => reports.getAllocation(db)],
  ["GET", /^\/portfolio\/history$/, ({ db }) => reports.getHistory(db)],
  [
    "GET",
    /^\/portfolio\/allocation\/(?<dim>[^/]+)$/,
    ({ db, params, query }) =>
      reports.allocationByDimension(db, { dim: params.dim, pillar: query.pillar, types: query.types }),
  ],
  [
    "GET",
    /^\/portfolio\/snapshot\/(?<year>[^/]+)\/(?<month>[^/]+)$/,
    ({ db, params }) => {
      const detail = reports.getSnapshotDetail(db, params.year, params.month);
      if (!detail) throw new DemoError(404, "SNAPSHOT_NOT_FOUND", "Snapshot not found");
      return detail;
    },
  ],
  ["POST", /^\/portfolio\/snapshot$/, ({ db, body }) => reports.createSnapshot(db, body)],
];

export const createServer = (fixture, { today = new Date() } = {}) => {
  const db = createState(fixture, today);
  // Two notifications already waiting, so the inbox has something to show.
  inbox.seedInbox(db);

  // method, a path as the frontend writes it (with or without the /api
  // prefix, query string included), and the parsed JSON body. Answers
  // { status, body } -- never throws.
  const handle = (method, url, body) => {
    const u = new URL(url, "http://demo.invalid");
    const path = u.pathname.replace(/^\/api(?=\/)/, "");
    const query = Object.fromEntries(u.searchParams);
    const verb = String(method || "GET").toUpperCase();

    try {
      for (const [m, pattern, fn] of ROUTES) {
        if (m !== verb) continue;
        const match = path.match(pattern);
        if (!match) continue;
        const result = fn({ db, params: match.groups || {}, query, body: body || {} });
        return { status: 200, body: result === undefined ? null : result };
      }
      // Everything else under /auth (sign-up, credentials, wallets, members,
      // administration) and all of /data (import and export) is out of scope.
      if (path.startsWith("/auth/") || path.startsWith("/data/")) throw disabled();
      return { status: 404, body: { code: "NOT_FOUND", error: "Not found" } };
    } catch (error) {
      if (error instanceof DemoError) {
        return { status: error.status, body: { code: error.code, error: error.message, ...(error.extra || {}) } };
      }
      console.error(`[demo] ${verb} ${path}:`, error);
      return { status: 500, body: { code: "REQUEST_FAILED", error: "The request failed" } };
    }
  };

  return { db, handle };
};
