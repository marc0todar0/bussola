#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The demo's dataset, and the check that the demo still answers like the API
// ---------------------------------------------------------------------------
// The demo (src/demo/) is a second implementation of the API's read and write
// logic, and a second implementation drifts. This keeps it honest, against a
// throwaway stack (api/test/stack.env):
//
//   node scripts/demo-check.mjs fixture    writes src/demo/fixture.json
//   node scripts/demo-check.mjs compare    fails if any answer of the demo
//                                          differs from the API's
//
// Both first load seed-demo.sql into the administrator's wallet and read the
// result back through the API. seed-demo.sql fills the instance's *first*
// wallet, so the administrator's has to be that one: run this on a fresh test
// stack before anything else creates wallets (CI runs `compare` first).
//
// `compare` then builds the demo on that very dataset and asks both the same
// questions -- lists, pages, filters, search, every summary and portfolio
// figure -- then makes the same writes on both (transactions added, edited
// and deleted, a holding, a snapshot), puts the demo's two inbox drafts into
// the API through a personal token and accepts one and dismisses the other on
// both, and asks again. Numbers may differ by half a cent; nothing else may.
//
// Environment: BASE_URL (http://localhost:3100), ADMIN_USER and ADMIN_PASS
// (the test stack's own), PG_CONTAINER (bussola-postgres).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/demo/server.js";
import { demoInboxDrafts } from "../src/demo/inbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const FIXTURE = join(HERE, "..", "src", "demo", "fixture.json");
const BASE = (process.env.BASE_URL || "http://localhost:3100").replace(/\/$/, "");
const ADMIN_USER = process.env.ADMIN_USER || "bussola";
const ADMIN_PASS = process.env.ADMIN_PASS || "test-admin-pass";
const PG = process.env.PG_CONTAINER || "bussola-postgres";

let cookie = "";
const call = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
};

const must = async (method, path, body) => {
  const r = await call(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
};

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const TODAY = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

const psql = (args, input) =>
  execFileSync("docker", ["exec", "-i", PG, "sh", "-c", `psql -q -v ON_ERROR_STOP=1 ${args} -U "$POSTGRES_USER" -d "$POSTGRES_DB"`], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });

// ---------------------------------------------------------------------------
// The dataset, as the API sees it
// ---------------------------------------------------------------------------
const loadSeed = async () => {
  await must("POST", "/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASS });
  let wallets = await must("GET", "/api/auth/wallets");
  if (!wallets.some((w) => w.mine)) {
    await must("POST", "/api/auth/wallets", { name: "Demo" });
    wallets = await must("GET", "/api/auth/wallets");
  }
  const own = wallets.filter((w) => w.mine).sort((a, b) => a.id - b.id)[0];
  await must("POST", "/api/auth/wallet", { walletId: own.id });
  psql("", readFileSync(join(REPO, "seed-demo.sql")));
  const accounts = await must("GET", "/api/accounts");
  if (!accounts.data.some((a) => a.name === "Demo Broker")) {
    throw new Error("seed-demo.sql filled another wallet: run this on a fresh test stack, before other tests");
  }
};

const readFixture = async () => {
  const me = await must("GET", "/api/auth/me");
  const accountTypes = {};
  for (const line of psql("-At -F '|' -c 'select id, code, name from account_types'").trim().split("\n")) {
    const [id, code, name] = line.split("|");
    accountTypes[id] = { code: code || null, name };
  }

  const active = await must("GET", "/api/accounts");
  const archived = await must("GET", "/api/accounts?archived=true");
  const accounts = [...active.data, ...archived.data].map(({ type_name: _t, n_asset_refresh: _n, ...row }) => row);

  for (const [kind, type_id] of [["expenses", 1], ["income", 2]]) {
    for (const flag of ["false", "true"]) {
      const r = await must("GET", `/api/categories/${kind}?from=19000101&to=29991231&archived=${flag}`);
      for (const { sum: _s, ...c } of r.data) {
        accounts.push({ ...c, amount: null, type_id, is_account: false, actual_amount: null });
      }
    }
  }

  const transactions = [];
  const transactionTypes = new Map();
  const users = { [me.id]: me.username };
  let cursor = null;
  do {
    const page = await must("GET", `/api/transactions?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const day of page.data) {
      for (const t of day.data) {
        transactionTypes.set(t.type_id, { id: t.type_id, code: t.type_code, name: t.type_name });
        if (t.created_by != null && t.created_by_name) users[t.created_by] = t.created_by_name;
        if (t.updated_by != null && t.updated_by_name) users[t.updated_by] = t.updated_by_name;
        const { id, type_id, amount, tx_date, description, updated_at, created_by, updated_by, from_id, to_id } = t;
        transactions.push({ id, type_id, amount, tx_date, description, updated_at, created_by, updated_by, from_id, to_id });
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  // The list gives the day only; the time of day decides which transaction
  // is the latest (the form's "used last time"), so it is read separately.
  const times = new Map(
    psql(`-At -F '|' -c "select id, to_char(tx_date, 'HH24:MI:SS.US') from transactions where wallet_id = ${Number(me.wallet.id)}"`)
      .trim()
      .split("\n")
      .map((line) => line.split("|"))
      .map(([id, time]) => [Number(id), time]),
  );
  for (const t of transactions) t.tx_time = times.get(t.id) || "00:00:00.000000";
  for (const [id, code, name] of [[1, "EXPENSE", "Expense"], [2, "INCOME", "Income"], [3, "TRANSFER", "Transfer"]]) {
    if (!transactionTypes.has(id)) transactionTypes.set(id, { id, code, name });
  }

  const holdings = [];
  for (const a of accounts.filter((x) => x.is_account)) {
    for (const h of await must("GET", `/api/accounts/${a.id}/holdings`)) {
      const { id, account_id, name, pillar_id, amount, description, type_id, issuer, country, currency, isin } = h;
      const { quantity, purchase_price, purchase_date, current_price, price_updated_at, auto_update } = h;
      holdings.push({
        id, account_id, name, pillar_id, amount, description, type_id, issuer, country, currency, isin,
        quantity, purchase_price, purchase_date, current_price, price_updated_at, auto_update,
      });
    }
  }

  const snapshots = [];
  for (const s of await must("GET", "/api/portfolio/history")) {
    const d = await must("GET", `/api/portfolio/snapshot/${s.year}/${s.month}`);
    const detail = d.diversification || d.accounts ? { diversification: d.diversification, accounts: d.accounts } : null;
    snapshots.push({ ...s, detail });
  }

  return {
    format: 1,
    generatedOn: `${TODAY.slice(0, 4)}-${TODAY.slice(4, 6)}-${TODAY.slice(6, 8)}`,
    user: { id: me.id, username: me.username },
    users,
    wallet: { id: me.wallet.id, name: me.wallet.name, currency: me.wallet.currency },
    accountTypes,
    transactionTypes: [...transactionTypes.values()].sort((a, b) => a.id - b.id),
    pillars: await must("GET", "/api/pillars"),
    holdingTypes: await must("GET", "/api/holding-types"),
    accounts: accounts.sort((a, b) => a.id - b.id),
    transactions: transactions.sort((a, b) => a.id - b.id),
    holdings: holdings.sort((a, b) => a.id - b.id),
    snapshots,
  };
};

// ---------------------------------------------------------------------------
// Comparing answers
// ---------------------------------------------------------------------------
const close = (a, b) => Math.abs(a - b) <= 0.006 || Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

// Arrays the API returns in no particular order (a GROUP BY, ties in an
// ORDER BY) are sorted by a stable key before comparing; `ordered` keeps the
// order of the ones where it is the point (pages, series, history) -- except
// the facets, which are sorted by a collation Postgres and the browser need
// not agree on to the letter.
const key = (x) =>
  x && typeof x === "object"
    ? JSON.stringify([x.type_id ?? null, x.id ?? x.to_id ?? x.value ?? null, x.name ?? x.label ?? null, x.year ?? null, x.month ?? null])
    : JSON.stringify(x);

const normalize = (value, { ordered, strip }, path = "") => {
  if (Array.isArray(value)) {
    const items = value.map((v, i) => normalize(v, { ordered, strip }, `${path}[${i}]`));
    const keepOrder = ordered && !/facets\.(from|to)$/.test(path);
    return keepOrder ? items : items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!strip.includes(k)) out[k] = normalize(v, { ordered, strip }, path ? `${path}.${k}` : k);
    return out;
  }
  return value;
};

const diff = (a, b, path, out) => {
  if (out.length >= 8) return;
  if (typeof a === "number" && typeof b === "number") {
    if (!close(a, b)) out.push(`${path}: ${a} vs ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: ${a.length} items vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else if (a !== b) {
    out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
};

const compare = async () => {
  console.log(`Demo check against ${BASE}\n`);
  await loadSeed();
  const fixture = await readFixture();
  const demo = createServer(fixture, { today: new Date() });
  const failures = [];
  let checks = 0;

  const ask = async (method, url, body, { ordered = false, strip = [], label } = {}) => {
    checks += 1;
    const api = await call(method, `/api${url}`, body);
    const mock = demo.handle(method, url, body);
    const out = [];
    if (api.status !== mock.status) out.push(`status ${api.status} vs ${mock.status}`);
    diff(normalize(api.json, { ordered, strip }), normalize(mock.body, { ordered, strip }), "", out);
    const name = label || `${method} ${url}`;
    console.log(`  ${out.length ? "FAIL" : "ok  "}  ${name}${out.map((l) => `\n        ${l}`).join("")}`);
    if (out.length) failures.push(name);
    return api.json;
  };

  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const year = `from=${y}0101&to=${y}1231`;
  const accounts = fixture.accounts.filter((a) => a.is_account && !a.archived);
  const investment = accounts.find((a) => a.is_investment);
  const someAccount = fixture.transactions[0].from_id;
  const history = await must("GET", "/api/portfolio/history");
  const lastSnapshot = history[history.length - 1];

  const reads = async (strip = []) => {
    await ask("GET", "/accounts", undefined, { strip });
    await ask("GET", "/accounts?archived=true", undefined, { strip });
    await ask("GET", `/categories/expenses?${year}`);
    await ask("GET", `/categories/income?${year}`);
    await ask("GET", "/categories/expenses");
    await ask("GET", `/categories/expenses?year=${prev.y}&month=${prev.m}`);
    await ask("GET", `/categories/expenses?${year}&archived=true`);
    const first = await ask("GET", "/transactions?limit=20", undefined, { ordered: true, strip });
    if (first && first.nextCursor) {
      await ask("GET", `/transactions?limit=20&cursor=${encodeURIComponent(first.nextCursor)}`, undefined, { ordered: true, strip });
    }
    await ask("GET", "/transactions?sort=amount&limit=20", undefined, { ordered: true, strip });
    await ask("GET", "/transactions?sort=amount&dir=asc&limit=20", undefined, { ordered: true, strip });
    await ask("GET", "/transactions?dir=asc&limit=20", undefined, { ordered: true, strip });
    await ask("GET", `/transactions?${year}&type=1`, undefined, { ordered: true, strip });
    await ask("GET", `/transactions?fromId=${someAccount}`, undefined, { ordered: true, strip });
    await ask("GET", "/transactions?q=groc", undefined, { ordered: true, strip });
    await ask("GET", "/transactions?q=salary%2022", undefined, { ordered: true, strip });
    await ask("GET", "/transactions/form-data");
    await ask("GET", `/summary?${year}`, undefined, { ordered: true });
    await ask("GET", `/summary/year?year=${y}`);
    await ask("GET", `/summary/month?year=${y}&month=${m}`);
    await ask("GET", `/summary/month?year=${prev.y}&month=${prev.m}`);
    await ask("GET", "/portfolio/allocation", undefined, { ordered: true });
    await ask("GET", "/portfolio/history", undefined, { ordered: true });
    for (const url of [
      "/portfolio/allocation/type",
      "/portfolio/allocation/broker",
      "/portfolio/allocation/issuer?types=ETF,ETN,ETP",
      "/portfolio/allocation/country?pillar=3",
      "/portfolio/allocation/issuer?pillar=3",
      "/portfolio/allocation/country?pillar=4",
      "/portfolio/allocation/issuer?pillar=4",
      "/portfolio/allocation/currency?pillar=4",
      "/portfolio/allocation/asset?types=CRYPTO",
    ]) {
      await ask("GET", url);
    }
    if (lastSnapshot) await ask("GET", `/portfolio/snapshot/${lastSnapshot.year}/${lastSnapshot.month}`, undefined, { strip });
    await ask("GET", "/pillars");
    await ask("GET", "/holding-types");
    await ask("GET", "/holdings/distinct/issuer", undefined, { ordered: true });
    await ask("GET", "/holdings/distinct/country", undefined, { ordered: true });
    for (const a of accounts.filter((x) => x.is_investment)) {
      await ask("GET", `/accounts/${a.id}/holdings`, undefined, { strip: [...strip, "price_updated_at"] });
    }
  };

  console.log("Reads on the seeded wallet:");
  await reads();

  console.log("\nThe same writes on both:");
  const form = await must("GET", "/api/transactions/form-data");
  const [a1, a2] = form.accounts;
  const category = form.expenseCategories[0];
  const [edited, removed] = fixture.transactions;
  const writes = [
    ["POST", "/transactions", { from_id: a1.id, to_id: category.id, amount: 12.34, type_id: 1, description: "demo-check expense", tx_date: TODAY }],
    ["POST", "/transactions", { from_id: a1.id, to_id: a2.id, amount: 50, type_id: 3, description: "demo-check transfer", tx_date: TODAY }],
    [
      "POST",
      `/transactions/${edited.id}`,
      { ...edited, amount: edited.amount + 1, description: "demo-check edited" },
    ],
    ["DELETE", `/transactions/${removed.id}`],
    ["POST", `/accounts/${investment.id}/holdings`, { name: "demo-check holding", pillar_id: 4, amount: 321, auto_update: false }],
    ["POST", "/portfolio/snapshot", {}],
    ["POST", "/accounts", { name: accounts[0].name.toUpperCase(), color: "gray", icon: "bank", iconFamily: "FontAwesome", amount: 1 }],
    ["DELETE", "/transactions/2147483000"],
  ];
  for (const [method, url, body] of writes) {
    await ask(method, url, body, { strip: ["id", "updated_at", "price_updated_at"] });
  }

  // The inbox. The demo opens with two invented notifications waiting; the
  // API is sent the same two the way a phone would send them -- through a
  // personal token, made with the administrator's password and revoked again
  // straight after -- so that both hold the same pending items. Their ids
  // differ (the API numbers its own), so the demo's items take the API's.
  console.log("\nThe inbox on both:");
  const minted = await must("POST", "/api/auth/tokens", { label: "demo-check", password: ADMIN_PASS });
  for (const item of demoInboxDrafts(demo.db)) {
    const r = await fetch(`${BASE}/api/inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${minted.token}` },
      body: JSON.stringify(item),
    });
    if (r.status !== 201) throw new Error(`POST /api/inbox with a token: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  await must("DELETE", `/api/auth/tokens/${minted.id}`);
  const pending = await must("GET", "/api/inbox");
  for (const it of pending) {
    const twin = demo.db.inbox.find((d) => d.merchant === it.merchant);
    if (twin) twin.id = it.id;
  }
  const inboxRead = { ordered: true, strip: ["received_at"] };
  await ask("GET", "/inbox", undefined, inboxRead);
  await ask("GET", "/auth/tokens");
  // What /me says the instance offers: no quotes, no model reading the
  // notifications, and no bank names -- the account and wallet differ.
  await ask("GET", "/auth/me", undefined, {
    strip: ["id", "username", "email", "locale", "currency", "isAdmin", "wallet"],
    label: "GET /auth/me: quotes, ai and bankNames",
  });
  const [toAccept, toDismiss] = pending;
  if (toAccept && toDismiss) {
    const confirmed = {
      from_id: toAccept.from_id,
      to_id: toAccept.to_id,
      amount: toAccept.amount,
      type_id: toAccept.type_id,
      description: toAccept.merchant,
      tx_date: toAccept.tx_date,
    };
    await ask("POST", `/inbox/${toAccept.id}/accept`, confirmed, { strip: ["transaction_id"] });
    await ask("POST", `/inbox/${toAccept.id}/accept`, confirmed, { label: "accepting twice is 409 INBOX_RESOLVED" });
    await ask("POST", `/inbox/${toDismiss.id}/dismiss`, {});
    await ask("POST", `/inbox/${toDismiss.id}/dismiss`, {}, { label: "dismissing twice is 409 INBOX_RESOLVED" });
  } else {
    failures.push("the API's inbox does not hold the two drafts sent to it");
  }
  await ask("POST", "/inbox/2147483000/dismiss", {}, { label: "an unknown item is 404 INBOX_NOT_FOUND" });
  await ask("GET", "/inbox", undefined, inboxRead);

  console.log("\nReads after the writes:");
  await reads(["id", "updated_at"]);

  console.log(`\n${checks - failures.length}/${checks} answers match.`);
  process.exit(failures.length ? 1 : 0);
};

// ---------------------------------------------------------------------------
// The shipped dataset
// ---------------------------------------------------------------------------
// The administrator's name is a test stack's detail: in the demo the one
// person is "demo", and every row they did not write is theirs too.
const writeFixture = async () => {
  await loadSeed();
  const fixture = await readFixture();
  for (const id of Object.keys(fixture.users)) fixture.users[id] = "demo";
  fixture.user.username = "demo";
  fixture.wallet.name = "Demo";
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(
    `${FIXTURE}: ${fixture.accounts.length} accounts and categories, ${fixture.transactions.length} transactions, ` +
      `${fixture.holdings.length} holdings, ${fixture.snapshots.length} snapshots.`,
  );
};

const mode = process.argv[2];
const run = mode === "fixture" ? writeFixture : mode === "compare" ? compare : null;
if (!run) {
  console.error("usage: demo-check.mjs fixture | compare");
  process.exit(2);
}
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
