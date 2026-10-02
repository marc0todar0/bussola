#!/usr/bin/env node
// ===========================================================================
// Summary regression check
// ===========================================================================
// Every number the summaries and the portfolio show, taken from one wallet
// twice -- before a change and after it -- and compared. It is the check to run
// around any change to the queries that add money up (summary, portfolio,
// balances, holdings) and around any change to how money is stored.
//
//   BASE_URL=http://localhost:3000 USERNAME=... PASSWORD=... \
//     node api/test/summary-regression.js snapshot before.json
//   ... apply the change ...
//   BASE_URL=... USERNAME=... PASSWORD=... \
//     node api/test/summary-regression.js compare before.json
//
// Read-only: it signs in and issues GETs, nothing else, so it may be pointed
// at a copy of real data. With more than one wallet, WALLET=<id> says which.
//
// What is collected, per year that has transactions: the year chart, the
// yearly and the twelve monthly category totals, each month's category lists
// and the transaction list's totals. Once: every account's balance (archived
// ones too), every investment account's holdings, the portfolio allocation by
// pillar and by each dimension, and the snapshot history.
//
// Each response is flattened into path -> number, with array elements keyed by
// what identifies them (id, month, code, name) rather than by position, so an
// order that changes does not read as a hundred differences. Ids, dates and
// timestamps are left out: they are not amounts.
//
// A value that moved by more than TOLERANCE (default 0.01, one cent) fails the
// comparison, and so does one that appeared or disappeared. Values that moved
// by less are counted and their largest move is printed: a change to how
// amounts are rounded is expected to move some of them by less than a cent.
const fs = require("node:fs");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
const TOLERANCE = Number(process.env.TOLERANCE || "0.01");
const [mode, file] = process.argv.slice(2);

if (!["snapshot", "compare"].includes(mode) || !file) {
  console.error("usage: summary-regression.js snapshot|compare <file.json>");
  process.exit(2);
}

let cookie = null;
const call = async (method, path, body) => {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of response.headers.getSetCookie()) {
    if (c.startsWith("bussola_sess=")) cookie = c.split(";")[0];
  }
  const text = await response.text();
  if (response.status !== 200) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return /json/.test(response.headers.get("content-type") || "") ? JSON.parse(text) : text;
};
const get = (path) => call("GET", path);

// Not amounts: identifiers, dates, and the transaction count per page.
const SKIP = /(^|_)id$|^ids?$|_at$|^year$|^month$|^day$|^date$|^tx_date$|^purchase_date$|^color$/;

const keyOf = (el, i) => {
  if (!el || typeof el !== "object") return String(i);
  if (el.id != null) return `id=${el.id}`;
  if (el.to_id != null) return `to=${el.to_id}`;
  if (el.year != null && el.month != null) return `${el.year}-${el.month}`;
  if (el.month != null) return `m=${el.month}${el.type_code ? `/${el.type_code}` : ""}`;
  if (el.date != null) return `d=${el.date}`;
  if (el.code != null) return `c=${el.code}`;
  if (el.name !== undefined) return `n=${el.name}`;
  return String(i);
};

const flatten = (node, prefix, out) => {
  if (Array.isArray(node)) {
    node.forEach((el, i) => flatten(el, `${prefix}[${keyOf(el, i)}]`, out));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (SKIP.test(k)) continue;
      flatten(v, `${prefix}.${k}`, out);
    }
  } else if (typeof node === "number") {
    out[prefix] = node;
  } else if (typeof node === "string" && /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(node)) {
    // A numeric column the driver hands back as text.
    out[prefix] = Number(node);
  }
  return out;
};

const collect = async () => {
  const me = await call("POST", "/api/auth/login", {
    username: process.env.USERNAME,
    password: process.env.PASSWORD,
  });
  if (process.env.WALLET) await call("POST", "/api/auth/wallet", { walletId: Number(process.env.WALLET) });
  else if (!me.wallet) throw new Error("this account has several wallets: say which with WALLET=<id>");

  const values = {};
  const take = async (label, path) => flatten(await get(path), label, values);

  // Which years to look at: the ones the transactions CSV spans.
  const csv = await get("/api/data/export/transactions.csv");
  const years = [...csv.matchAll(/^\uFEFF?(\d{4})-\d{2}-\d{2}/gm)].map((m) => Number(m[1]));
  const first = years.length ? Math.min(...years) : new Date().getFullYear();
  const last = years.length ? Math.max(...years) : first;

  for (let y = first; y <= last; y++) {
    await take(`summary/${y}`, `/api/summary?from=${y}0101&to=${y}1231`);
    await take(`year/${y}`, `/api/summary/year?year=${y}`);
    await take(`tx/${y}`, `/api/transactions?from=${y}0101&to=${y}1231&limit=500`);
    for (let m = 1; m <= 12; m++) {
      await take(`month/${y}-${m}`, `/api/summary/month?year=${y}&month=${m}`);
      await take(`expenses/${y}-${m}`, `/api/categories/expenses?year=${y}&month=${m}`);
      await take(`income/${y}-${m}`, `/api/categories/income?year=${y}&month=${m}`);
    }
  }
  await take("tx/all", "/api/transactions?limit=500");

  const active = await get("/api/accounts");
  const archived = await get("/api/accounts?archived=true");
  flatten(active, "accounts", values);
  flatten(archived, "archived", values);
  for (const a of [...active.data, ...archived.data].filter((x) => x.is_investment)) {
    await take(`holdings/${a.id}`, `/api/accounts/${a.id}/holdings`);
  }

  await take("allocation", "/api/portfolio/allocation");
  await take("history", "/api/portfolio/history");
  for (const dim of ["type", "issuer", "country", "currency", "broker", "asset"]) {
    await take(`allocation/${dim}`, `/api/portfolio/allocation/${dim}`);
  }
  return { base: BASE, taken: new Date().toISOString(), years: [first, last], values };
};

const compare = (before, after) => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const failures = [];
  let moved = 0;
  let largest = 0;
  for (const k of [...keys].sort()) {
    const a = before[k];
    const b = after[k];
    if (a === undefined || b === undefined) {
      failures.push(`${k}: ${a === undefined ? "appeared" : "disappeared"} (${a ?? b})`);
      continue;
    }
    const d = Math.abs(a - b);
    if (d > TOLERANCE + 1e-9) failures.push(`${k}: ${a} -> ${b} (${b - a > 0 ? "+" : ""}${+(b - a).toFixed(6)})`);
    else if (d > 0) {
      moved += 1;
      largest = Math.max(largest, d);
    }
  }
  return { compared: keys.size, failures, moved, largest };
};

(async () => {
  const snap = await collect();
  if (mode === "snapshot") {
    fs.writeFileSync(file, JSON.stringify(snap, null, 1));
    console.log(`${Object.keys(snap.values).length} values from ${snap.years.join("-")} written to ${file}`);
    return;
  }
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  const r = compare(before.values, snap.values);
  console.log(`${r.compared} values compared against ${file} (taken ${before.taken})`);
  console.log(`${r.moved} moved by less than ${TOLERANCE}` + (r.moved ? `, the largest by ${+r.largest.toFixed(9)}` : ""));
  if (r.failures.length) {
    console.log(`\n${r.failures.length} FAILED:`);
    for (const f of r.failures.slice(0, 200)) console.log(`  ${f}`);
    if (r.failures.length > 200) console.log(`  ... and ${r.failures.length - 200} more`);
    process.exit(1);
  }
  console.log("OK");
})().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
