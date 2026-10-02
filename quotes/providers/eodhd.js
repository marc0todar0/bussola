// ----------------------------------------------------------------------------
// EODHD -- stocks, ETFs and ETCs by ISIN, through EODHD's official API
// (https://eodhd.com/financial-apis). The person running Bussola brings a free
// key of their own in EODHD_API_KEY (the free plan: 20 calls a day); without
// it this provider is skipped. It is the last resort of the chain in
// providers/stocks.js, for what the other two do not cover (a gold ETC on
// Xetra, for one), so the quota is spent only on those.
//
//   1. GET search/{ISIN}?api_token=...&fmt=json
//      -> [ { Code, Exchange, Name, Type, Currency, ISIN, previousClose } ]
//      One entry per listing. The entry on Xetra in the wallet's currency if
//      there is one, else Frankfurt, else any other in that currency. The
//      listing chosen -- or that there is none -- is kept 24 h per (ISIN,
//      currency): a search costs a call, and "not covered" does not change
//      from one refresh to the next.
//   2. GET real-time/{Code}.{Exchange}?api_token=...&fmt=json
//      -> { code, close, change_p, previousClose, ... }   (delayed quote)
//
// Errors: 401/403 a refused key, 402 and 429 the day's calls used up, 404 an
// unknown symbol. Every failure is an outcome the chain understands (see
// providers/twelvedata.js). Nothing that names the instrument is logged.
// ----------------------------------------------------------------------------
const { fetchJson, baseFrom, sayOnce, debugShape } = require("./shared");

const DEFAULT_BASE = "https://eodhd.com/api/";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX = 5000;

const apiKey = () => String(process.env.EODHD_API_KEY || "").trim();
const eodhdEnabled = () => Boolean(apiKey());

const url = (path, params = {}) => {
  const u = new URL(path, baseFrom("EODHD_BASE_URL", DEFAULT_BASE));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("fmt", "json");
  u.searchParams.set("api_token", apiKey());
  return u.toString();
};

// (ISIN|currency) -> { listing, other } -- listing null when there is none in
// that currency, `other` when there is one in another.
const listings = new Map();
const clearEodhd = () => listings.clear();

// null for a success, else the outcome the failure means.
const failure = (answer) => {
  if (!answer) return { outcome: "unavailable" };
  const { status } = answer;
  if (status >= 200 && status < 300) return null;
  if (status === 402 || status === 429) {
    console.log(`[quotes] EODHD: the day's calls are used up (${status})`);
    return { outcome: "unavailable" };
  }
  if (status === 401 || status === 403) {
    sayOnce(`eodhd${status}`, `[quotes] EODHD refused the key (${status}): check EODHD_API_KEY`);
    return { outcome: "unavailable" };
  }
  if (status === 404) return { outcome: "notFound" };
  console.log(`[quotes] EODHD: HTTP ${status}`);
  return { outcome: "unavailable" };
};

const norm = (s) => String(s || "").trim().toUpperCase();
const pick = (entries) =>
  entries.find((e) => e.exchange === "XETRA") || entries.find((e) => e.exchange === "F") || entries[0] || null;

// { listing, other } or a failure outcome.
const findListing = async (isin, unit, deadline) => {
  const cacheKey = `${isin}|${unit}`;
  const hit = listings.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (hit) listings.delete(cacheKey);

  const answer = await fetchJson(url(`search/${encodeURIComponent(isin)}`), { label: "EODHD", deadline });
  debugShape("EODHD search", answer);
  const failed = failure(answer);
  if (failed && failed.outcome !== "notFound") return failed;

  const rows = !failed && Array.isArray(answer.body) ? answer.body : [];
  const inUnit = [];
  let other = false;
  for (const r of rows) {
    if (!r || !r.Code || !r.Exchange || norm(r.ISIN) !== isin) continue;
    const entry = { code: String(r.Code), exchange: norm(r.Exchange), currency: norm(r.Currency) };
    if (entry.currency === unit) inUnit.push(entry);
    else if (entry.currency) other = true;
  }

  const value = { listing: pick(inUnit), other };
  listings.set(cacheKey, { value, expires: Date.now() + TTL_MS });
  while (listings.size > MAX) listings.delete(listings.keys().next().value);
  return value;
};

const num = (v) => (v == null || v === "" ? NaN : Number(v));

const lookupEodhd = async (isin, unit, { deadline } = {}) => {
  const found = await findListing(isin, unit, deadline);
  if (found.outcome) return found;
  if (!found.listing) return { outcome: found.other ? "currency" : "notFound" };
  const { listing } = found;

  const answer = await fetchJson(
    url(`real-time/${encodeURIComponent(`${listing.code}.${listing.exchange}`)}`),
    { label: "EODHD", deadline },
  );
  debugShape("EODHD real-time", answer);
  const failed = failure(answer);
  if (failed) return failed;
  const q = answer.body && typeof answer.body === "object" ? answer.body : {};

  // "NA" is what the API writes for a price it does not have.
  const price = num(q.close);
  if (!Number.isFinite(price) || price <= 0) return { outcome: "notFound" };
  const change = num(q.change_p);
  return {
    outcome: "price",
    price,
    change: Number.isFinite(change) ? Number(change.toFixed(2)) : null,
    quoteCurrency: listing.currency,
    symbol: listing.exchange,
    source: "eodhd",
  };
};

module.exports = { lookupEodhd, eodhdEnabled, clearEodhd };
