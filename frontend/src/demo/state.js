// ---------------------------------------------------------------------------
// The demo's database
// ---------------------------------------------------------------------------
// A copy of fixture.json -- the invented dataset of seed-demo.sql, read back
// from a real instance by scripts/demo-check.mjs -- kept in memory for as long
// as the tab lives. Its dates move with the calendar: the transactions keep
// their distance from the day the fixture was generated, so the newest ones
// are always this week's and the demo never opens on an empty month.
//
// Plain JavaScript with no browser API beyond the standard library, so that
// scripts/demo-check.mjs can run the same code in Node and compare its answers
// with the real API's.

const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, "0");

// Days are YYYYMMDD strings throughout, as tx_date travels in the API's
// answers: they compare correctly as strings.
export const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
export const fromYmd = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
export const dashed = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
export const daysBetween = (a, b) => Math.round((b - a) / DAY_MS);

// Money as numeric(14,2) keeps it. A JS sum of 148.7 and 564.4 is
// 713.0999999999999; the column's is 713.1.
export const money = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

// An error the API would have answered with a code: the router turns it into
// the same status and body.
export class DemoError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const invalid = (message = "The request is not valid") => new DemoError(400, "INVALID_REQUEST", message);

// An id from the URL. Postgres answers a non-numeric one with a cast error,
// which the API turns into 400 INVALID_REQUEST.
export const intParam = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n)) throw invalid();
  return n;
};

export const byId = (rows, id) => rows.find((r) => r.id === Number(id));

// The order Postgres gives text under the image's en_US collation, near
// enough for dropdowns and legends.
export const collate = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), "en");

export const createState = (fixture, today = new Date()) => {
  const db = structuredClone(fixture);
  const day0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const generated = fromYmd(fixture.generatedOn.replace(/-/g, ""));
  const days = daysBetween(generated, day0);
  const months =
    day0.getFullYear() * 12 + day0.getMonth() - (generated.getFullYear() * 12 + generated.getMonth());

  if (days) {
    for (const t of db.transactions) {
      const d = fromYmd(t.tx_date);
      d.setDate(d.getDate() + days);
      t.tx_date = ymd(d);
    }
  }
  if (months) {
    for (const s of db.snapshots) {
      const n = s.year * 12 + s.month - 1 + months;
      s.year = Math.floor(n / 12);
      s.month = (n % 12) + 1;
    }
  }

  const maxId = (rows) => rows.reduce((m, r) => Math.max(m, r.id || 0), 0);
  db.today = day0;
  db.locale = null;
  db.lastStamp = 0;
  db.sequences = {
    accounts: maxId(db.accounts),
    transactions: maxId(db.transactions),
    holdings: maxId(db.holdings),
    holdingTypes: maxId(db.holdingTypes),
  };
  return db;
};

export const nextId = (db, table) => (db.sequences[table] += 1);

// updated_at for a row written now, strictly after the previous one: two
// writes in the same millisecond still sort in the order they happened, as
// they do in the database.
export const stamp = (db) => {
  db.lastStamp = Math.max(Date.now(), db.lastStamp + 1);
  return new Date(db.lastStamp).toISOString();
};

// ---------------------------------------------------------------------------
// Periods -- api/services/period.js, with days kept as YYYYMMDD
// ---------------------------------------------------------------------------
const badDate = () => new DemoError(400, "INVALID_DATE_RANGE", "Dates must be valid and written as YYYYMMDD");

export const parseDay = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value);
  if (!/^\d{8}$/.test(s)) throw badDate();
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw badDate();
  return s;
};

export const dayRange = (query = {}) => {
  const from = parseDay(query.from);
  const to = parseDay(query.to);
  if (from && to && from > to) {
    throw new DemoError(400, "INVALID_DATE_RANGE", "The start date is after the end date");
  }
  return { from, to };
};

export const yearOf = (db, value) => {
  const y = value === undefined || value === null || value === "" ? db.today.getFullYear() : Number(value);
  if (!Number.isInteger(y) || y < 1000 || y > 9999) {
    throw new DemoError(400, "INVALID_DATE_RANGE", "The year is not valid");
  }
  return y;
};

export const monthOf = (db, value) => {
  const m = value === undefined || value === null || value === "" ? db.today.getMonth() + 1 : Number(value);
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new DemoError(400, "INVALID_DATE_RANGE", "The month is not valid");
  }
  return m;
};

export const monthRange = (year, month) => ({
  from: `${year}${pad(month)}01`,
  to: `${year}${pad(month)}${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`,
});

export const yearRange = (year) => ({ from: `${year}0101`, to: `${year}1231` });

export const inRange = (day, { from, to }) => (!from || day >= from) && (!to || day <= to);
