// ---------------------------------------------------------------------------
// Summaries, the portfolio and holdings -- summary_controller,
// portfolio_controller and holdings_controller, over the in-memory rows
// ---------------------------------------------------------------------------
import {
  DemoError,
  byId,
  collate,
  dayRange,
  daysBetween,
  inRange,
  intParam,
  invalid,
  money,
  monthOf,
  monthRange,
  nextId,
  stamp,
  yearOf,
  yearRange,
} from "./state.js";

const EXPENSE = 1;
const INCOME = 2;
const DIFFERENCE = -1;

const sum = (rows, pick) => money(rows.reduce((s, r) => s + (Number(pick(r)) || 0), 0));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
export const getChartData = (db, query) => {
  const range = dayRange(query);
  const rows = db.transactions.filter((t) => inRange(t.tx_date, range));
  const byMonth = new Map();
  for (const t of rows) {
    const month = Number(t.tx_date.slice(4, 6));
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(t);
  }
  const totals = new Map(
    [...byMonth].map(([month, list]) => [
      month,
      {
        expenses: sum(list.filter((t) => t.type_id === EXPENSE), (t) => t.amount),
        income: sum(list.filter((t) => t.type_id === INCOME), (t) => t.amount),
      },
    ]),
  );
  const series = (typeCode, typeId, pick) =>
    Array.from({ length: 12 }, (_, i) => {
      const r = totals.get(i + 1);
      return { month: i + 1, type_code: typeCode, type_id: typeId, total: r ? pick(r) : 0 };
    });

  const expenses = series("EXPENSE", EXPENSE, (r) => r.expenses);
  const income = series("INCOME", INCOME, (r) => r.income);
  const difference = series("DIFFERENCE", DIFFERENCE, (r) => r.income - r.expenses);
  const sumTotals = (list) => list.reduce((acc, c) => acc + c.total, 0);
  return {
    difference,
    expenses,
    income,
    totals: { difference: sumTotals(difference), income: sumTotals(income), expenses: sumTotals(expenses) },
  };
};

const totalsByCategory = (db, range) => {
  const groups = new Map();
  for (const t of db.transactions) {
    if (!inRange(t.tx_date, range)) continue;
    const key = `${t.type_id}|${t.to_id}`;
    if (!groups.has(key)) groups.set(key, { type_id: t.type_id, to_id: t.to_id, rows: [] });
    groups.get(key).rows.push(t);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, account: byId(db.accounts, g.to_id) }))
    .filter((g) => g.account)
    .map(({ type_id, to_id, account, rows }) => ({
      type_id,
      to_id,
      name: account.name,
      color: account.color,
      icon: account.icon,
      icon_family: account.icon_family,
      category_total: sum(rows, (t) => t.amount),
    }));
};

const withTotal = (rows) => ({ data: rows, total: rows.reduce((acc, row) => acc + row.category_total, 0) });

const splitByType = (sums) => ({
  expenses: withTotal(sums.filter((c) => c.type_id == EXPENSE)),
  income: withTotal(sums.filter((c) => c.type_id == INCOME)),
  transfer: withTotal(sums.filter((c) => c.type_id == 3)),
});

export const getMonthlyData = (db, query) => {
  const year = yearOf(db, query.year);
  const month = monthOf(db, query.month);
  return { year, month, ...splitByType(totalsByCategory(db, monthRange(year, month))) };
};

export const getYearlyData = (db, query) => {
  const year = yearOf(db, query.year);
  return { year, ...splitByType(totalsByCategory(db, yearRange(year))) };
};

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------
export const getPillars = (db) => db.pillars.map(({ id, code, name, color }) => ({ id, code, name, color }));

export const getHoldingTypes = (db) =>
  [...db.holdingTypes]
    .sort((a, b) => collate(a.name, b.name) || a.id - b.id)
    .map(({ id, code, name, color, custom }) => ({ id, code, name, color, custom }));

export const createHoldingType = (db, body = {}) => {
  const name = body.name == null ? "" : String(body.name).trim();
  if (!name) throw new DemoError(400, "INVALID_REQUEST", "The holding type needs a name");
  if (!db.holdingTypes.some((t) => String(t.name).trim().toLowerCase() === name.toLowerCase())) {
    db.holdingTypes.push({
      id: nextId(db, "holdingTypes"),
      code: null,
      name,
      color: body.color == null || body.color === "" ? null : body.color,
      custom: true,
    });
  }
  return getHoldingTypes(db);
};

export const deleteHoldingType = (db, id) => {
  const typeId = Number(id);
  const type = db.holdingTypes.find((t) => t.id === typeId && t.custom);
  if (!type) throw new DemoError(404, "HOLDING_TYPE_NOT_FOUND", "Holding type not found");
  db.holdingTypes = db.holdingTypes.filter((t) => t !== type);
  for (const h of db.holdings) if (h.type_id === typeId) h.type_id = null;
  return getHoldingTypes(db);
};

export const getDistinctValues = (db, field) => {
  if (field !== "issuer" && field !== "country") throw new DemoError(400, "INVALID_REQUEST", "Invalid field");
  return [...new Set(db.holdings.map((h) => h[field]).filter((v) => v != null && v !== ""))].sort(collate);
};

const fromDashed = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));

export const getHoldings = (db, accountId) => {
  const id = Number(accountId);
  return db.holdings
    .filter((h) => h.account_id === id)
    .map((h) => {
      const p = byId(db.pillars, h.pillar_id);
      const t = h.type_id == null ? null : byId(db.holdingTypes, h.type_id);
      const pp = h.purchase_price == null ? null : Number(h.purchase_price);
      const cp = h.current_price == null ? null : Number(h.current_price);
      const priced = pp != null && pp !== 0 && cp != null;
      const days = h.purchase_date ? daysBetween(fromDashed(h.purchase_date), db.today) : null;
      return {
        id: h.id,
        account_id: h.account_id,
        name: h.name,
        pillar_id: h.pillar_id,
        amount: h.amount,
        description: h.description,
        type_id: h.type_id,
        issuer: h.issuer,
        country: h.country,
        currency: h.currency,
        isin: h.isin,
        quantity: h.quantity,
        purchase_price: h.purchase_price,
        purchase_date: h.purchase_date,
        current_price: h.current_price,
        total_return: priced ? ((cp - pp) / pp) * 100 : null,
        annualised_return: priced && days > 0 ? (Math.pow(cp / pp, 365 / days) - 1) * 100 : null,
        price_updated_at: h.price_updated_at,
        auto_update: h.auto_update,
        pillar_code: p ? p.code : null,
        pillar_name: p ? p.name : null,
        pillar_color: p ? p.color : null,
        type_code: t ? t.code : null,
        type_name: t ? t.name : null,
        type_color: t ? t.color : null,
      };
    })
    .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0) || a.id - b.id);
};

// amount = quantity x price when both are there, otherwise the value typed.
const computeAmount = ({ amount, quantity, current_price }) => {
  const q = Number(quantity);
  const p = Number(current_price);
  const hasQ = quantity != null && quantity !== "" && !Number.isNaN(q);
  const hasP = current_price != null && current_price !== "" && !Number.isNaN(p);
  if (hasQ && hasP) return q * p;
  return Number(amount) || 0;
};

const numOrNull = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const strOrNull = (v) => (v == null || v === "" ? null : v);

const holdingFields = (db, body) => {
  const pillarId = body.pillar_id || 1;
  if (!byId(db.pillars, pillarId)) throw invalid();
  const typeId = numOrNull(body.type_id);
  if (typeId != null && !byId(db.holdingTypes, typeId)) throw invalid();
  return {
    name: body.name,
    pillar_id: Number(pillarId),
    amount: money(computeAmount(body)),
    description: strOrNull(body.description),
    type_id: typeId,
    issuer: strOrNull(body.issuer),
    country: strOrNull(body.country),
    currency: strOrNull(body.currency),
    isin: strOrNull(body.isin),
    quantity: numOrNull(body.quantity),
    purchase_price: numOrNull(body.purchase_price),
    purchase_date: body.purchase_date ? String(body.purchase_date).slice(0, 10) : null,
    current_price: numOrNull(body.current_price),
    auto_update: body.auto_update === false ? false : true,
  };
};

// An account's actual balance is the sum of its holdings' values.
const recompute = (db, accountId) => {
  const account = byId(db.accounts, accountId);
  if (account) account.actual_amount = sum(db.holdings.filter((h) => h.account_id === account.id), (h) => h.amount);
};

export const createHolding = (db, accountId, body = {}) => {
  const account = byId(db.accounts, intParam(accountId));
  if (!account || !account.is_account) throw new DemoError(404, "ACCOUNT_NOT_FOUND", "No such account");
  db.holdings.push({
    id: nextId(db, "holdings"),
    account_id: account.id,
    ...holdingFields(db, body),
    price_updated_at: null,
  });
  recompute(db, account.id);
  return getHoldings(db, account.id);
};

const holdingNotFound = () => new DemoError(404, "HOLDING_NOT_FOUND", "Holding not found");

export const updateHolding = (db, hid, body = {}) => {
  const h = byId(db.holdings, intParam(hid));
  if (!h) throw holdingNotFound();
  Object.assign(h, holdingFields(db, body));
  stamp(db);
  recompute(db, h.account_id);
  return getHoldings(db, h.account_id);
};

export const deleteHolding = (db, hid) => {
  const h = byId(db.holdings, intParam(hid));
  if (!h) throw holdingNotFound();
  db.holdings = db.holdings.filter((x) => x !== h);
  recompute(db, h.account_id);
  return getHoldings(db, h.account_id);
};

// No quote service can be reached from the demo (and its CSP would not let
// one be), so it answers the three refresh endpoints the way an instance with
// no quotes service does: 409 QUOTES_DISABLED, before looking at what it was asked to
// refresh -- holdings_controller.requireQuotes() comes first too.
const quotesDisabled = () =>
  new DemoError(409, "QUOTES_DISABLED", "Price updates are not configured on this instance");

export const refreshAll = () => {
  throw quotesDisabled();
};

export const refreshAccount = () => {
  throw quotesDisabled();
};

export const refreshHolding = () => {
  throw quotesDisabled();
};

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------
const activeInvestment = (db, h) => {
  const a = byId(db.accounts, h.account_id);
  return a && a.is_account && a.is_investment && !a.archived;
};

const cashTotal = (db) =>
  sum(
    db.accounts.filter((a) => a.is_account && !a.is_investment && !a.archived),
    (a) => a.actual_amount ?? a.amount,
  );

const computeCurrentAllocation = (db) => {
  const invested = db.holdings.filter((h) => activeInvestment(db, h));
  const cash = cashTotal(db);
  return [...db.pillars]
    .sort((a, b) => a.id - b.id)
    .map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      color: p.color,
      value: money(sum(invested.filter((h) => h.pillar_id === p.id), (h) => h.amount) + (p.id === 1 ? cash : 0)) || 0,
    }));
};

export const getAllocation = (db) => {
  const data = computeCurrentAllocation(db);
  return { total: data.reduce((acc, d) => acc + d.value, 0), data };
};

const DIMENSIONS = {
  type: (db, h) => {
    const t = h.type_id == null ? null : byId(db.holdingTypes, h.type_id);
    return { key: t ? t.name : null, color: t ? t.color : null, code: t ? t.code : null };
  },
  issuer: (db, h) => ({ key: h.issuer, color: null, code: null }),
  country: (db, h) => ({ key: h.country, color: null, code: null }),
  currency: (db, h) => ({ key: h.currency, color: null, code: null }),
  broker: (db, h) => {
    const a = byId(db.accounts, h.account_id);
    return { key: a.name, color: a.color, code: null };
  },
  asset: (db, h) => ({ key: h.name, color: null, code: null }),
};

// min() over text, which is what the SQL takes when a group has several.
const minOf = (values) => values.filter((v) => v != null).sort()[0] ?? null;

export const allocationByDimension = (db, { dim, pillar, types } = {}) => {
  const pick = DIMENSIONS[dim];
  if (!pick) throw new DemoError(400, "INVALID_REQUEST", "Invalid dimension");
  const hasPillar = pillar != null && pillar !== "";
  const typeCodes = types
    ? String(types)
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean)
    : [];

  const groups = new Map();
  for (const h of db.holdings) {
    if (!activeInvestment(db, h)) continue;
    if (hasPillar && h.pillar_id !== Number(pillar)) continue;
    if (typeCodes.length) {
      const t = h.type_id == null ? null : byId(db.holdingTypes, h.type_id);
      if (!t || !typeCodes.includes(t.code)) continue;
    }
    const g = pick(db, h);
    if (!groups.has(g.key)) groups.set(g.key, { name: g.key, colors: [], codes: [], rows: [] });
    const entry = groups.get(g.key);
    entry.colors.push(g.color);
    entry.codes.push(g.code);
    entry.rows.push(h);
  }
  const data = [...groups.values()]
    .map((g) => ({ name: g.name ?? null, code: minOf(g.codes), color: minOf(g.colors), value: sum(g.rows, (h) => h.amount) }))
    .filter((g) => g.value > 0)
    .sort((a, b) => b.value - a.value);

  if (dim === "type" && !hasPillar && !typeCodes.length) {
    const cash = cashTotal(db);
    if (cash > 0) {
      const existing = data.find((x) => x.code === "CASH");
      if (existing) existing.value += cash;
      else data.push({ name: "Cash", code: "CASH", color: "#90a4ae", value: cash });
      data.sort((a, b) => b.value - a.value);
    }
  }
  return { total: data.reduce((acc, x) => acc + x.value, 0), data };
};

export const getHistory = (db) =>
  [...db.snapshots]
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .map(({ year, month, total, value_p1, value_p2, value_p3, value_p4 }) => ({
      year,
      month,
      total,
      value_p1,
      value_p2,
      value_p3,
      value_p4,
    }));

export const getSnapshotDetail = (db, year, month) => {
  const r = db.snapshots.find((s) => s.year === Number(year) && s.month === Number(month));
  if (!r) return null;
  const byPillar = { 1: r.value_p1, 2: r.value_p2, 3: r.value_p3, 4: r.value_p4 };
  const detail = r.detail || {};
  return {
    year: r.year,
    month: r.month,
    total: Number(r.total) || 0,
    allocation: {
      total: Number(r.total) || 0,
      data: [...db.pillars]
        .sort((a, b) => a.id - b.id)
        .map((p) => ({ id: p.id, code: p.code, name: p.name, color: p.color, value: Number(byPillar[p.id]) || 0 })),
    },
    diversification: detail.diversification || null,
    accounts: detail.accounts || null,
  };
};

const DIVERSIF_SNAPSHOT = [
  { key: "type", args: { dim: "type" } },
  { key: "broker", args: { dim: "broker" } },
  { key: "issuer_etf", args: { dim: "issuer", types: "ETF,ETN,ETP" } },
  { key: "bond_country", args: { dim: "country", pillar: 3 } },
  { key: "bond_issuer", args: { dim: "issuer", pillar: 3 } },
  { key: "equity_country", args: { dim: "country", pillar: 4 } },
  { key: "equity_issuer", args: { dim: "issuer", pillar: 4 } },
  { key: "equity_currency", args: { dim: "currency", pillar: 4 } },
  { key: "crypto", args: { dim: "asset", types: "CRYPTO" } },
];

const buildDetail = (db) => {
  const diversification = {};
  for (const d of DIVERSIF_SNAPSHOT) diversification[d.key] = allocationByDimension(db, d.args);
  const type = db.accountTypes[3] || {};
  const accounts = db.accounts
    .filter((a) => a.is_account && !a.archived)
    .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
    .map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      icon: a.icon,
      icon_family: a.icon_family,
      amount: a.amount,
      actual_amount: a.actual_amount,
      is_investment: a.is_investment,
      is_current: a.is_current,
      type_code: type.code ?? null,
      type_name: type.name ?? null,
      holdings: a.is_investment
        ? getHoldings(db, a.id).map((h) => ({
            ...h,
            cost: h.quantity != null && h.purchase_price != null ? Number(h.quantity) * Number(h.purchase_price) : null,
          }))
        : [],
    }));
  return { diversification, accounts };
};

// The same rule as the API's snapshotPeriod (portfolio_controller.js): the
// snapshot is labelled with the month it is taken in unless the body names
// another, and a year or month that is not one is a 400.
const snapshotPart = (value, fallback, min, max, what) => {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new DemoError(400, "INVALID_SNAPSHOT_PERIOD", `The snapshot's ${what} is not valid`);
  }
  return n;
};

export const createSnapshot = (db, body = {}) => {
  const year = snapshotPart(body.year, db.today.getFullYear(), 1900, 2999, "year");
  const month = snapshotPart(body.month, db.today.getMonth() + 1, 1, 12, "month");
  const allocation = computeCurrentAllocation(db);
  const value = (id) => (allocation.find((p) => p.id === id) || {}).value || 0;
  const total = allocation.reduce((acc, p) => acc + p.value, 0);
  const row = {
    year,
    month,
    total: money(total),
    value_p1: value(1),
    value_p2: value(2),
    value_p3: value(3),
    value_p4: value(4),
    detail: buildDetail(db),
  };
  const index = db.snapshots.findIndex((s) => s.year === year && s.month === month);
  if (index >= 0) db.snapshots[index] = row;
  else db.snapshots.push(row);
  return { year, month, total, data: allocation };
};
