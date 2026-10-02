// ----------------------------------------------------------------------------
// Eulerpool -- stocks and ETFs by ISIN, through Eulerpool's official API
// (https://eulerpool.com/developers). The person running Bussola brings a
// free key of their own in EULERPOOL_API_KEY; without it this provider is
// skipped. The key goes as the `token` query parameter.
//
// Two paths, because Eulerpool files stocks and ETFs apart (shapes checked
// against the live API, 2026-09-29):
//
//   Stocks   GET market/quotes/exchanges/{ISIN}
//            { primary: "NASDAQ", exchanges: [ { exchange: "Frankfurt",
//              currency: "EUR", bid: 296.2, ask: 296.3, timestamp } ] }
//            The listing in the wallet's currency -- the primary exchange if
//            it quotes in it, else Xetra/Frankfurt, else any -- priced at the
//            middle of bid and ask. No daily change is given.
//            An ETF answers 404 {"error":"Security not found"} here.
//
//   ETFs     GET etf/profile/{ISIN}
//            { currency, tickers: [ { ticker: "VWCE.DE", exchange: "xetra" } ] }
//            then GET etf/quotes/{TICKER}  ->  [ [epoch ms, close], ... ]
//            The ticker of an exchange that trades in the wallet's currency
//            (Xetra first), and the last daily close of its series: a closing
//            price, a day or two behind. The change is the last close against
//            the one before. The profile is kept for a day.
//            The series has no currency of its own; it is the exchange's, so
//            only exchanges whose currency is not in doubt are used (London
//            lists the same fund in dollars and in pounds: it is skipped).
//
// Errors: 401 authentication_error, 404 not_found, 429 rate_limit_exceeded,
// 5xx server_error. Every failure is an outcome the chain in
// providers/stocks.js understands (see providers/twelvedata.js).
// DEBUG_QUOTES=1 logs each answer's key names and array lengths (never a
// value, never the ISIN).
// ----------------------------------------------------------------------------
const { fetchJson, baseFrom, sayOnce, debugShape } = require("./shared");

const DEFAULT_BASE = "https://api.eulerpool.com/api/1/";
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

const apiKey = () => String(process.env.EULERPOOL_API_KEY || "").trim();
const eulerpoolEnabled = () => Boolean(apiKey());

const url = (path, params = {}) => {
  const u = new URL(path, baseFrom("EULERPOOL_BASE_URL", DEFAULT_BASE));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("token", apiKey());
  return u.toString();
};

// "notFound" / "unavailable" for a failed answer, null for a success.
const failure = (answer) => {
  if (!answer) return "unavailable";
  const { status } = answer;
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) {
    sayOnce(`eulerpool${status}`, `[quotes] Eulerpool refused the key (${status}): check EULERPOOL_API_KEY`);
    return "unavailable";
  }
  if (status === 404) return "notFound";
  console.log(`[quotes] Eulerpool: HTTP ${status}${status === 429 ? " (rate limit)" : ""}`);
  return "unavailable";
};

const num = (v) => (v == null || v === "" ? NaN : Number(v));
const positive = (n) => (Number.isFinite(n) && n > 0 ? n : null);
const norm = (s) => String(s || "").trim().toLowerCase();

// The currency each exchange trades in, where there is no doubt about it,
// in the order they are preferred for that currency.
const EXCHANGE_CURRENCY = [
  ["xetra", "EUR"], ["frankfurt", "EUR"], ["milan", "EUR"], ["amsterdam", "EUR"], ["euronext", "EUR"],
  ["paris", "EUR"], ["brussels", "EUR"], ["madrid", "EUR"], ["lisbon", "EUR"], ["vienna", "EUR"],
  ["dublin", "EUR"], ["helsinki", "EUR"], ["stuttgart", "EUR"], ["munich", "EUR"], ["berlin", "EUR"],
  ["dusseldorf", "EUR"], ["hamburg", "EUR"],
  ["six", "CHF"], ["swiss", "CHF"],
  ["nyse", "USD"], ["nasdaq", "USD"], ["nyse arca", "USD"], ["amex", "USD"], ["cboe", "USD"],
];
const rank = (exchange, unit) =>
  EXCHANGE_CURRENCY.findIndex(([name, cur]) => cur === unit && name === norm(exchange));
const currencyOf = (exchange) => (EXCHANGE_CURRENCY.find(([name]) => name === norm(exchange)) || [])[1] || null;

// --- stocks -------------------------------------------------------------------

const PREFERRED_VENUES = ["xetra", "frankfurt"];

const stockQuote = (body, unit) => {
  const list = Array.isArray(body && body.exchanges) ? body.exchanges : [];
  const quotes = list
    .map((e) => {
      // A side quoted as 0 (or below) is a side with no order, not a price:
      // averaging it in halved the quote. Only positive sides count.
      const bid = positive(num(e.bid));
      const ask = positive(num(e.ask));
      const price = bid != null && ask != null ? (bid + ask) / 2 : bid != null ? bid : ask != null ? ask : NaN;
      return { venue: String(e.exchange || "").trim(), currency: String(e.currency || "").toUpperCase(), price };
    })
    .filter((q) => Number.isFinite(q.price) && q.price > 0);
  const inUnit = quotes.filter((q) => q.currency === unit);
  const primary = inUnit.find((q) => norm(q.venue) === norm(body.primary));
  const preferred = PREFERRED_VENUES.map((v) => inUnit.find((q) => norm(q.venue) === v)).find(Boolean);
  return { quote: primary || preferred || inUnit[0] || null, other: quotes.some((q) => q.currency !== unit) };
};

// --- ETFs ---------------------------------------------------------------------

const profiles = new Map(); // ISIN -> { at, profile }

const etfProfile = async (isin, deadline) => {
  const hit = profiles.get(isin);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return { profile: hit.profile };
  const answer = await fetchJson(url(`etf/profile/${encodeURIComponent(isin)}`), { label: "Eulerpool", deadline });
  debugShape("Eulerpool etf/profile", answer);
  const failed = failure(answer);
  if (failed) return { failed };
  const profile = answer.body && typeof answer.body === "object" ? answer.body : {};
  profiles.set(isin, { at: Date.now(), profile });
  return { profile };
};

const lastCloses = (body) => {
  const rows = Array.isArray(body) ? body.filter((r) => Array.isArray(r) && Number.isFinite(num(r[1]))) : [];
  if (!rows.length) return null;
  const last = num(rows[rows.length - 1][1]);
  const before = rows.length > 1 ? num(rows[rows.length - 2][1]) : NaN;
  const change = Number.isFinite(before) && before > 0 ? ((last - before) / before) * 100 : null;
  return last > 0 ? { price: last, change } : null;
};

const etfQuote = async (isin, unit, deadline) => {
  const { profile, failed } = await etfProfile(isin, deadline);
  if (failed) return { outcome: failed };
  const tickers = (Array.isArray(profile.tickers) ? profile.tickers : [])
    .filter((t) => t && t.ticker)
    .map((t) => ({ ticker: String(t.ticker), exchange: String(t.exchange || "") }));
  const usable = tickers
    .filter((t) => rank(t.exchange, unit) >= 0)
    .sort((a, b) => rank(a.exchange, unit) - rank(b.exchange, unit))
    .filter((t, i, all) => all.findIndex((o) => o.ticker === t.ticker) === i);

  let transient = false;
  for (const t of usable.slice(0, 2)) {
    const answer = await fetchJson(url(`etf/quotes/${encodeURIComponent(t.ticker)}`), { label: "Eulerpool", deadline });
    debugShape("Eulerpool etf/quotes", answer);
    const failedQuote = failure(answer);
    if (failedQuote === "unavailable") {
      transient = true;
      continue;
    }
    const q = !failedQuote && lastCloses(answer.body);
    if (q) return priced({ ...q, venue: t.exchange }, unit);
  }
  if (transient) return { outcome: "unavailable" };
  const elsewhere = tickers.some((t) => currencyOf(t.exchange) && currencyOf(t.exchange) !== unit)
    || (profile.currency && String(profile.currency).toUpperCase() !== unit);
  return { outcome: usable.length || !elsewhere ? "notFound" : "currency" };
};

// --- the lookup ---------------------------------------------------------------

const lookupEulerpool = async (isin, unit, { deadline } = {}) => {
  const byExchange = await fetchJson(url(`market/quotes/exchanges/${encodeURIComponent(isin)}`), { label: "Eulerpool", deadline });
  debugShape("Eulerpool quotes/exchanges", byExchange);
  const failed = failure(byExchange);
  if (failed === "unavailable") return { outcome: "unavailable" };
  if (!failed) {
    const { quote, other } = stockQuote(byExchange.body, unit);
    if (quote) return priced(quote, unit);
    if (other) return { outcome: "currency" };
  }
  // Not a stock Eulerpool knows (or none of its quotes in this currency):
  // perhaps an ETF.
  return etfQuote(isin, unit, deadline);
};

const priced = (quote, unit) => ({
  outcome: "price",
  price: Math.round(quote.price * 10000) / 10000,
  change: Number.isFinite(quote.change) ? Number(quote.change.toFixed(2)) : null,
  quoteCurrency: unit,
  symbol: quote.venue ? quote.venue.slice(0, 32) : null,
  source: "eulerpool",
});

const clearEulerpoolCache = () => profiles.clear();

module.exports = { lookupEulerpool, eulerpoolEnabled, stockQuote, lastCloses, clearEulerpoolCache };
