// ---------------------------------------------------------------------------
// Accounts, categories and transactions -- what accounts_controller and
// transactions_controller do, over the in-memory rows
// ---------------------------------------------------------------------------
// Each function answers what its API endpoint answers, field for field, so the
// pages cannot tell the difference. scripts/demo-check.mjs holds them to it.
import {
  DemoError,
  byId,
  collate,
  dashed,
  dayRange,
  inRange,
  intParam,
  invalid,
  money,
  monthOf,
  monthRange,
  nextId,
  parseDay,
  stamp,
  yearOf,
  ymd,
} from "./state.js";

// Type ids: 1 = expense, 2 = income, 3 = transfer. A category's own type is
// the account type 1 (expense) or 2 (income); a bank account's is 3.
const EXPENSE = 1;
const INCOME = 2;
const CATEGORY_KIND = { 1: "EXPENSE", 2: "INCOME" };

const nameOf = (db, id) => (id == null ? null : (db.users[id] ?? null));

// ---------------------------------------------------------------------------
// Balances: balanceEffects() and moveBalance() of transactions_controller
// ---------------------------------------------------------------------------
export const balanceEffects = (t) => {
  const amount = t.amount == null ? null : Number(t.amount);
  const effects = [];
  if (t.type_id != INCOME) effects.push({ accountId: t.from_id, delta: amount == null ? null : -amount });
  if (t.type_id != EXPENSE) {
    effects.push({ accountId: t.type_id == INCOME ? t.from_id : t.to_id, delta: amount });
  }
  return effects;
};

// An investment account's actual balance is its holdings' value, which money
// moving in or out does not change (ACTUAL_AFTER_MOVE); for any other account
// NULL, "the same as the balance".
const moveBalance = (db, accountId, delta) => {
  const a = byId(db.accounts, accountId);
  if (!a) return;
  a.amount = a.amount == null || delta == null ? null : money(a.amount + delta);
  a.actual_amount = a.is_investment ? a.actual_amount : null;
};

const apply = (db, t, sign) => {
  for (const { accountId, delta } of balanceEffects(t)) {
    moveBalance(db, accountId, delta == null ? null : sign * delta);
  }
};

// ---------------------------------------------------------------------------
// The transaction list
// ---------------------------------------------------------------------------
const LIMIT_DEFAULT = 100;
const LIMIT_MIN = 20;
const LIMIT_MAX = 500;

const oneOf = (value, allowed, fallback, name) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (!allowed.includes(value)) throw invalid(`${name} must be one of ${allowed.join(", ")}`);
  return value;
};

const optionalId = (value, name) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw invalid(`${name} must be a positive integer`);
  return n;
};

const pageSize = (value) => {
  if (value === undefined || value === null || value === "") return LIMIT_DEFAULT;
  const n = Number(value);
  if (!Number.isInteger(n)) throw invalid("limit must be an integer");
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, n));
};

const normalizeText = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

const searchTokens = (q) =>
  normalizeText(String(q ?? "").slice(0, 200))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => t.slice(0, 64));

// base64url of a small JSON object, byte for byte what the API's Buffer
// produces, so a cursor from either side means the same page.
const toBase64url = (text) => {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64url = (s) => {
  const binary = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
};

const badCursor = () => new DemoError(400, "INVALID_CURSOR", "This page marker is not valid; load the list again");

const encodeCursor = (c) => toBase64url(JSON.stringify(c));

const decodeCursor = (raw, sort) => {
  if (raw === undefined || raw === null || raw === "") return null;
  let c;
  try {
    if (typeof raw !== "string" || raw.length > 256) throw badCursor();
    c = JSON.parse(fromBase64url(raw));
  } catch {
    throw badCursor();
  }
  if (!c || typeof c !== "object") throw badCursor();
  if (sort === "date") {
    if (c.k !== "d" || typeof c.v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.v)) throw badCursor();
    try {
      parseDay(c.v.replace(/-/g, ""));
    } catch {
      throw badCursor();
    }
    return { k: "d", v: c.v };
  }
  if (c.k !== "a" || typeof c.a !== "number" || !Number.isFinite(c.a)) throw badCursor();
  if (!Number.isInteger(c.id) || c.id < 0 || c.id > 2147483647) throw badCursor();
  return { k: "a", a: c.a, id: c.id };
};

// One row of the list, with the columns transactions_controller's COLUMNS
// selects plus the two author names.
const txRow = (db, t) => {
  const tt = db.transactionTypes.find((x) => x.id === t.type_id) || {};
  const fa = byId(db.accounts, t.from_id) || {};
  const ta = byId(db.accounts, t.to_id) || {};
  return {
    id: t.id,
    type_id: tt.id,
    type_code: tt.code,
    type_name: tt.name,
    amount: t.amount,
    tx_date: t.tx_date,
    description: t.description,
    updated_at: t.updated_at,
    created_by: t.created_by,
    updated_by: t.updated_by,
    from_id: fa.id,
    from_name: fa.name,
    from_color: fa.color,
    from_icon: fa.icon,
    from_icon_family: fa.icon_family,
    to_id: ta.id,
    to_name: ta.name,
    to_color: ta.color,
    to_icon: ta.icon,
    to_icon_family: ta.icon_family,
    created_by_name: nameOf(db, t.created_by),
    updated_by_name: nameOf(db, t.updated_by),
  };
};

// The search's haystack: the note, both names, the type, and the amount as
// 78.20 and as 78,20.
const haystack = (db, t) => {
  const r = txRow(db, t);
  const amount = t.amount == null ? null : Number(t.amount).toFixed(2);
  return normalizeText(
    [r.description, r.from_name, r.to_name, r.type_name, amount, amount && amount.replace(".", ",")]
      .filter((x) => x != null)
      .join(" "),
  );
};

const listFilter = (db, query) => {
  const range = dayRange(query);
  const type = optionalId(query.type, "type");
  const fromId = optionalId(query.fromId, "fromId");
  const toId = optionalId(query.toId, "toId");
  const tokens = searchTokens(query.q);
  const inPeriod = (t) => inRange(t.tx_date, range);
  const matches = (t) =>
    inPeriod(t) &&
    (!type || t.type_id === type) &&
    (!fromId || t.from_id === fromId) &&
    (!toId || t.to_id === toId) &&
    (tokens.length === 0 || tokens.every((token) => haystack(db, t).includes(token)));
  return { inPeriod, matches };
};

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// updated_at desc nulls last, as the list orders a day's rows.
const lastTouchedFirst = (a, b) => {
  if (a.updated_at == null && b.updated_at == null) return 0;
  if (a.updated_at == null) return 1;
  if (b.updated_at == null) return -1;
  return cmp(b.updated_at, a.updated_at);
};

const groupByDay = (rows) => {
  const groups = [];
  let current = null;
  for (const row of rows) {
    if (!current || current.id !== row.tx_date) {
      current = { id: row.tx_date, data: [] };
      groups.push(current);
    }
    current.data.push(row);
  }
  return groups;
};

// Pages of whole days: about `limit` rows, rounded up to the end of the day
// of the limit-th one.
const datePage = (db, rows, dir, limit, cursor) => {
  const desc = dir === "desc";
  let list = rows;
  if (cursor) {
    const c = cursor.v.replace(/-/g, "");
    list = list.filter((t) => (desc ? t.tx_date < c : t.tx_date > c));
  }
  const walk = [...list].sort((a, b) => cmp(a.tx_date, b.tx_date) || a.id - b.id);
  if (desc) walk.reverse();
  const edge = walk[limit - 1];
  const day = edge ? edge.tx_date : null;

  const page = (day ? list.filter((t) => (desc ? t.tx_date >= day : t.tx_date <= day)) : [...list]).sort(
    (a, b) => (desc ? cmp(b.tx_date, a.tx_date) : cmp(a.tx_date, b.tx_date)) || lastTouchedFirst(a, b) || b.id - a.id,
  );
  const more = day && list.some((t) => (desc ? t.tx_date < day : t.tx_date > day));
  return {
    flat: false,
    data: groupByDay(page.map((t) => txRow(db, t))),
    nextCursor: more ? encodeCursor({ k: "d", v: dashed(day) }) : null,
  };
};

const amountKey = (t) => Math.abs(Number(t.amount) || 0);

const amountPage = (db, rows, dir, limit, cursor) => {
  const asc = dir !== "desc";
  const sign = asc ? 1 : -1;
  let list = [...rows].sort((a, b) => sign * (amountKey(a) - amountKey(b) || a.id - b.id));
  if (cursor) {
    list = list.filter((t) => {
      const k = amountKey(t);
      return asc ? k > cursor.a || (k === cursor.a && t.id > cursor.id) : k < cursor.a || (k === cursor.a && t.id < cursor.id);
    });
  }
  const more = list.length > limit;
  const data = list.slice(0, limit);
  const last = data[data.length - 1];
  return {
    flat: true,
    data: data.map((t) => txRow(db, t)),
    nextCursor: more ? encodeCursor({ k: "a", a: Math.abs(Number(last.amount) || 0), id: last.id }) : null,
  };
};

const sumOf = (rows, pick = (r) => r.amount) => money(rows.reduce((s, r) => s + (Number(pick(r)) || 0), 0));

const facets = (db, rows) => {
  const side = (key) => {
    const ids = new Set(rows.map((t) => t[key]));
    return db.accounts
      .filter((a) => ids.has(a.id))
      .map((a) => ({ value: a.id, label: a.name }))
      .sort((x, y) => collate(x.label, y.label) || x.value - y.value);
  };
  return { from: side("from_id"), to: side("to_id") };
};

export const getTransactions = (db, query) => {
  const sort = oneOf(query.sort, ["date", "amount"], "date", "sort");
  const dir = oneOf(query.dir, ["desc", "asc"], "desc", "dir");
  const limit = pageSize(query.limit);
  const cursor = decodeCursor(query.cursor, sort);
  const filter = listFilter(db, query);
  const rows = db.transactions.filter(filter.matches);

  const page = sort === "amount" ? amountPage(db, rows, dir, limit, cursor) : datePage(db, rows, dir, limit, cursor);
  if (cursor) return page;
  return {
    ...page,
    totIn: sumOf(rows.filter((t) => t.type_id === INCOME)),
    totOut: sumOf(rows.filter((t) => t.type_id === EXPENSE)),
    count: rows.length,
    facets: facets(db, db.transactions.filter(filter.inPeriod)),
  };
};

// Postgres' ORDER BY amount DESC puts NULLs first.
const byAmountDesc = (a, b) => {
  if (a.amount == null || b.amount == null) return (b.amount == null) - (a.amount == null) || a.id - b.id;
  return b.amount - a.amount || a.id - b.id;
};

// The latest transaction first: tx_date desc -- the day, then the time of day
// it carries -- updated_at desc nulls last, id desc.
const newestFirst = (a, b) =>
  cmp(b.tx_date, a.tx_date) || cmp(b.tx_time ?? "", a.tx_time ?? "") || lastTouchedFirst(a, b) || b.id - a.id;

export const getNewTransactionData = (db) => {
  const pick = (isAccount, typeId) =>
    db.accounts
      .filter((a) => a.is_account === isAccount && a.type_id === typeId && !a.archived)
      .map(({ id, name, color, icon, amount, type_id, description, is_account, icon_family }) => ({
        id,
        name,
        color,
        icon,
        amount,
        type_id,
        description,
        is_account,
        icon_family,
      }));

  const lastUsed = {};
  for (const tt of db.transactionTypes) {
    const last = db.transactions.filter((t) => t.type_id === tt.id).sort(newestFirst)[0];
    if (last) lastUsed[tt.id] = { from_id: last.from_id, to_id: last.to_id };
  }

  return {
    accounts: pick(true, 3).sort(byAmountDesc),
    expenseCategories: pick(false, 1).sort((a, b) => a.id - b.id),
    incomeCategories: pick(false, 2).sort((a, b) => a.id - b.id),
    lastUsed,
  };
};

// What the insert would refuse: a missing end (the foreign keys), a type that
// does not exist, an amount that is not a number. Checked before anything
// moves, as the database transaction would roll everything back.
const validTransaction = (db, body) => {
  const from = byId(db.accounts, body.from_id);
  const to = byId(db.accounts, body.to_id);
  const type = db.transactionTypes.find((t) => t.id === Number(body.type_id));
  const amount = body.amount === null || body.amount === undefined || body.amount === "" ? null : Number(body.amount);
  if (!from || !to || !type || (amount !== null && !Number.isFinite(amount))) throw invalid();
  return { from_id: from.id, to_id: to.id, type_id: type.id, amount: money(amount) };
};

// tx_date as the insert would store it, as a day and a time of day: YYYYMMDD
// as the form sends it (midnight), an ISO timestamp as written (a timestamp
// column without time zone drops the zone), or today at midnight when there
// is none -- the API's own default is a YYYYMMDD too.
const MIDNIGHT = "00:00:00.000000";

const txDate = (value) => {
  if (value === undefined || value === null || value === "") return { day: ymd(new Date()), time: MIDNIGHT };
  const s = String(value);
  if (/^\d{8}$/.test(s)) return { day: parseDay(s), time: MIDNIGHT };
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?/);
  if (!m) throw invalid();
  const [, y, mo, d, hh = "00", mi = "00", ss = "00", frac = ""] = m;
  return { day: parseDay(`${y}${mo}${d}`), time: `${hh}:${mi}:${ss}.${frac.padEnd(6, "0")}` };
};

export const createTransaction = (db, body, user) => {
  const fields = validTransaction(db, body);
  const when = txDate(body.tx_date);
  const row = {
    id: nextId(db, "transactions"),
    ...fields,
    tx_date: when.day,
    tx_time: when.time,
    description: body.description ?? null,
    updated_at: stamp(db),
    created_by: user.id,
    updated_by: null,
  };
  db.transactions.push(row);
  apply(db, row, 1);
  const { from_id, to_id, amount, type_id, description, tx_date } = body;
  return { from_id, to_id, amount, type_id, description, tx_date };
};

const vanished = () => new DemoError(404, "TRANSACTION_NOT_FOUND", "The transaction no longer exists");

export const updateTransaction = (db, id, body, user) => {
  const index = db.transactions.findIndex((t) => t.id === intParam(id));
  if (index < 0) throw vanished();
  const fields = validTransaction(db, body);
  const when = txDate(body.tx_date);

  const old = db.transactions[index];
  apply(db, old, -1);
  const edited = {
    id: old.id,
    ...fields,
    tx_date: when.day,
    tx_time: when.time,
    description: body.description ?? null,
    updated_at: stamp(db),
    created_by: old.created_by,
    updated_by: user.id,
  };
  db.transactions[index] = edited;
  apply(db, edited, 1);
  return "Updated transaction with id:" + id;
};

export const deleteTransaction = (db, id) => {
  const index = db.transactions.findIndex((t) => t.id === intParam(id));
  if (index < 0) throw vanished();
  const [removed] = db.transactions.splice(index, 1);
  apply(db, removed, -1);
  return "Deleted transaction with id:" + id;
};

// ---------------------------------------------------------------------------
// Accounts and categories
// ---------------------------------------------------------------------------
const nameKey = (s) => String(s ?? "").trim().toLowerCase();

// The API's unique index on names: one name per wallet and per kind.
const assertNameFree = (db, name, typeId, exceptId) => {
  if (name === undefined || name === null) return;
  const key = nameKey(name);
  const clash = db.accounts.some(
    (a) => a.type_id === typeId && a.id !== exceptId && a.name != null && nameKey(a.name) === key,
  );
  if (clash) throw new DemoError(409, "NAME_TAKEN", "This wallet already has an account or category with that name");
};

export const getAccounts = (db, query) => {
  const archived = query.archived === "true";
  const rows = db.accounts.filter((a) => a.is_account && a.archived === archived);
  const refreshable = (a) =>
    db.holdings.filter((h) => h.account_id === a.id && h.auto_update === true && h.isin != null && h.isin !== "")
      .length;
  const total = (pick) => {
    const values = rows.map(pick).filter((v) => v != null);
    return values.length ? money(values.reduce((s, v) => s + Number(v), 0)) : null;
  };
  return {
    totalAmount: total((a) => a.amount),
    totalActualAmount: total((a) => a.actual_amount ?? a.amount),
    accountCount: rows.length,
    currentCount: rows.filter((a) => a.is_current).length,
    investmentCount: rows.filter((a) => a.is_investment).length,
    data: rows
      .map((a) => ({ ...a, type_name: db.accountTypes[a.type_id]?.name ?? null, n_asset_refresh: refreshable(a) }))
      .sort(byAmountDesc),
  };
};

const numberOrUndefined = (value, name) => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw invalid(`${name} must be a number`);
  return n;
};

export const createAccount = (db, body, user) => {
  const isInvestment = body.is_investment === true;
  const isCurrent = body.is_current !== false;
  assertNameFree(db, body.name, 3);
  const amount = money(body.amount ?? null);
  const actual = isInvestment ? money(body.actual_amount || body.amount) : amount;
  const row = {
    id: nextId(db, "accounts"),
    name: body.name,
    color: body.color,
    icon: body.icon,
    icon_family: body.iconFamily,
    amount,
    type_id: 3,
    description: body.description ?? null,
    is_account: true,
    actual_amount: actual,
    archived: false,
    is_current: isCurrent,
    is_investment: isInvestment,
    created_by: user.id,
    wallet_id: db.wallet.id,
  };
  db.accounts.push(row);
  // The API answers with the model it built, which never had an id.
  const { id: _id, wallet_id: _w, created_by: _c, archived: _a, ...model } = row;
  return model;
};

export const updateAccount = (db, id, body) => {
  const account = db.accounts.find((a) => a.id === intParam(id) && a.is_account);
  if (!account) throw new DemoError(404, "ACCOUNT_NOT_FOUND", "No such account");
  const isInvestment = body.is_investment === true;
  const isCurrent = body.is_current !== false;
  const previous = numberOrUndefined(body.previous_amount, "previous_amount");
  const requested = previous === undefined ? undefined : numberOrUndefined(body.amount, "amount");
  const setsBalance = previous !== undefined && requested !== undefined;

  if (setsBalance && !(Math.abs((account.amount ?? 0) - previous) < 0.005)) {
    throw new DemoError(
      409,
      "BALANCE_CHANGED",
      "The balance changed while the account was being edited: check it and save again",
      { balance: account.amount },
    );
  }
  assertNameFree(db, body.name, 3, account.id);

  Object.assign(account, {
    name: body.name,
    color: body.color,
    icon: body.icon,
    icon_family: body.iconFamily,
    description: body.description,
    is_current: isCurrent,
    is_investment: isInvestment,
    amount: setsBalance ? money(requested) : account.amount,
    actual_amount: isInvestment
      ? money(db.holdings.filter((h) => h.account_id === account.id).reduce((s, h) => s + (Number(h.amount) || 0), 0))
      : null,
  });
  return {
    id: account.id,
    name: body.name,
    color: body.color,
    icon: body.icon,
    icon_family: body.iconFamily,
    amount: account.amount,
    type_id: 3,
    description: body.description,
    is_account: true,
    actual_amount: null,
    is_current: isCurrent,
    is_investment: isInvestment,
  };
};

// A missing row, or one of the other kind (an account id sent to a categories
// endpoint or the other way round), is a 404 ACCOUNT_NOT_FOUND, as in the API.
const notFound = (label) => new DemoError(404, "ACCOUNT_NOT_FOUND", `No such ${label}`);
const ofKind = (db, id, isAccount) => db.accounts.find((a) => a.id === intParam(id) && a.is_account === isAccount);

export const setArchived = (db, id, archived, isAccount) => {
  const row = ofKind(db, id, isAccount);
  if (!row) throw notFound(isAccount ? "account" : "category");
  row.archived = archived;
  return { id: Number(id), archived };
};

// Transactions keep their accounts and categories (the foreign keys refuse,
// and the API answers 400); holdings go with their account.
export const deleteAccountOrCategory = (db, id, label) => {
  const row = ofKind(db, id, label === "account");
  if (!row) throw notFound(label);
  if (db.transactions.some((t) => t.from_id === row.id || t.to_id === row.id)) throw invalid();
  db.accounts = db.accounts.filter((a) => a.id !== row.id);
  db.holdings = db.holdings.filter((h) => h.account_id !== row.id);
  // Inbox proposals naming it lose it (ON DELETE SET NULL on the id column,
  // migration 002); the items themselves stay.
  for (const item of db.inbox || []) {
    if (item.from_id === row.id) item.from_id = null;
    if (item.to_id === row.id) item.to_id = null;
  }
  return `Deleted ${label} with id:${id}`;
};

export const getCategories = (db, kind, query) => {
  const asked = dayRange(query);
  const range =
    asked.from && asked.to ? asked : monthRange(yearOf(db, query.year), monthOf(db, query.month));
  const typeCode = kind === "income" ? "INCOME" : kind === "expenses" ? "EXPENSE" : "UNKNOWN";
  const txTypeId = kind === "income" ? INCOME : kind === "expenses" ? EXPENSE : -1;
  const archived = query.archived === "true";

  const inPeriod = db.transactions.filter((t) => inRange(t.tx_date, range));
  const totalFor = (id) => {
    const rows = inPeriod.filter((t) => t.type_id === txTypeId && t.to_id === id);
    return rows.length ? sumOf(rows) : null;
  };
  const data = db.accounts
    .filter((a) => !a.is_account && CATEGORY_KIND[a.type_id] === typeCode && a.archived === archived)
    .sort((a, b) => a.id - b.id)
    .map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      icon: a.icon,
      icon_family: a.icon_family,
      description: a.description,
      archived: a.archived,
      sum: totalFor(a.id),
    }));

  // Income into income categories and expenses into expense categories, the
  // archived ones included; NULL, like SUM over nothing, when there is none.
  const into = (txType, kindCode) => {
    const rows = inPeriod.filter((t) => {
      const c = byId(db.accounts, t.to_id);
      return t.type_id === txType && c && !c.is_account && CATEGORY_KIND[c.type_id] === kindCode;
    });
    return rows.length ? sumOf(rows) : null;
  };
  return { totInMonth: into(INCOME, "INCOME"), totOutMonth: into(EXPENSE, "EXPENSE"), data };
};

const categoryModel = (id, body, typeId) => ({
  ...(id === undefined ? {} : { id }),
  name: body.name,
  color: body.color,
  icon: body.icon,
  icon_family: body.iconFamily,
  amount: null,
  type_id: typeId,
  description: body.description,
  is_account: false,
});

export const createCategory = (db, body, user) => {
  const typeId = body.isExpense ? 1 : 2;
  assertNameFree(db, body.name, typeId);
  db.accounts.push({
    id: nextId(db, "accounts"),
    name: body.name,
    color: body.color,
    icon: body.icon,
    icon_family: body.iconFamily,
    amount: null,
    type_id: typeId,
    description: body.description ?? null,
    is_account: false,
    actual_amount: null,
    archived: false,
    created_by: user.id,
    wallet_id: db.wallet.id,
  });
  return categoryModel(undefined, body, typeId);
};

export const updateCategory = (db, id, body) => {
  const row = ofKind(db, id, false);
  if (!row) throw notFound("category");
  const typeId = body.isExpense ? 1 : 2;
  // The kind is fixed once money has been booked to the category.
  if (row.type_id !== typeId && db.transactions.some((t) => t.from_id === row.id || t.to_id === row.id)) {
    throw new DemoError(
      409,
      "CATEGORY_IN_USE",
      "This category has transactions: it cannot change between expense and income",
    );
  }
  assertNameFree(db, body.name, typeId, row.id);
  Object.assign(row, {
    name: body.name,
    color: body.color,
    icon: body.icon,
    icon_family: body.iconFamily,
    type_id: typeId,
    description: body.description,
  });
  return categoryModel(String(id), body, typeId);
};
