const DataError = require("./dataError");

// ---------------------------------------------------------------------------
// Periods: two calendar days, both included
// ---------------------------------------------------------------------------
// transactions.tx_date is a timestamp, not a date. "Up to the 30th" written as
// `tx_date <= '2026-06-30'` means up to midnight *at the start* of the 30th,
// so anything recorded later that day fell out of the list, the totals and the
// summaries alike. Every range is therefore half-open:
//
//   tx_date >= from::timestamp  AND  tx_date < to::timestamp + interval '1 day'
//
// (cast to timestamp, not date: see rangeSql below for why it matters under
// Row Level Security)
// which takes the whole of the last day and still lets the planner use the
// (wallet_id, tx_date) indexes. export_controller.js has done this since it
// was written; this module is the same rule for the endpoints that take their
// days as YYYYMMDD, which is what the interface sends.

const COMPACT_DAY = /^\d{8}$/;

const badDate = () =>
  new DataError(400, "INVALID_DATE_RANGE", "Dates must be valid and written as YYYYMMDD");

// "20260630" -> "2026-06-30", after checking that the day exists: 20260231
// is refused here rather than handed to Postgres as a cast error.
const parseDay = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value);
  if (!COMPACT_DAY.test(s)) throw badDate();
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw badDate();
  }
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

// The optional ?from=&to= of a request, each null when absent.
const dayRange = (query = {}) => {
  const from = parseDay(query.from);
  const to = parseDay(query.to);
  if (from && to && from > to) {
    throw new DataError(400, "INVALID_DATE_RANGE", "The start date is after the end date");
  }
  return { from, to };
};

// A calendar month or year as the same two inclusive days. Year and month are
// checked because they end up in a date: month 13 is a 400, not a cast error.
const yearOf = (value) => {
  const y = value === undefined || value === null || value === "" ? new Date().getFullYear() : Number(value);
  if (!Number.isInteger(y) || y < 1000 || y > 9999) {
    throw new DataError(400, "INVALID_DATE_RANGE", "The year is not valid");
  }
  return y;
};

const monthOf = (value) => {
  const m = value === undefined || value === null || value === "" ? new Date().getMonth() + 1 : Number(value);
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new DataError(400, "INVALID_DATE_RANGE", "The month is not valid");
  }
  return m;
};

const pad = (n) => String(n).padStart(2, "0");

const monthRange = (year, month) => {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
};

const yearRange = (year) => ({ from: `${year}-01-01`, to: `${year}-12-31` });

// The predicate for a range, with its parameters appended to `params`.
// `column` is always a constant written in the caller, never input.
//
// The bounds are cast to timestamp, the column's own type, and not to date.
// It is the same instant either way, but under Row Level Security it decides
// whether the index can be used at all: a condition may only be pushed into an
// index scan ahead of the policy if its operator is leakproof, and
// timestamp >= timestamp is while timestamp >= date is not. Written with
// ::date, every range here became a filter over the wallet's whole history.
const rangeSql = (column, { from, to }, params) => {
  const parts = [];
  if (from) {
    params.push(from);
    parts.push(`${column} >= $${params.length}::timestamp`);
  }
  if (to) {
    params.push(to);
    parts.push(`${column} < $${params.length}::timestamp + interval '1 day'`);
  }
  return parts;
};

module.exports = { parseDay, dayRange, yearOf, monthOf, monthRange, yearRange, rangeSql };
