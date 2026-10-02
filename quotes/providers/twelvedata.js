// ----------------------------------------------------------------------------
// Twelve Data -- ETFs and stocks, through Twelve Data's official API
// (https://twelvedata.com/docs). The person running Bussola brings a free key
// of their own in TWELVEDATA_API_KEY (the Basic plan: 800 credits a day, 8 a
// minute); without it this provider is skipped.
//
// The Basic plan cannot look an ISIN up, so an ISIN becomes a listing in
// three steps:
//
//   1. OpenFIGI (providers/openfigi.js): the ISIN's tickers.
//   2. GET symbol_search?symbol=<ticker>&apikey=...
//      -> { data: [ { symbol, instrument_name, exchange, mic_code,
//                     instrument_type, country, currency } ], status: "ok" }
//      The entries whose symbol is the ticker and whose currency is the
//      wallet's; on Xetra (XETR) if there is one, else on another European
//      market, else any. The listing chosen is kept 24 h per (ISIN, currency).
//   3. GET quote?symbol=<symbol>&mic_code=<mic>&apikey=...
//      -> { symbol, name, exchange, mic_code, currency, close,
//           percent_change, ... }   (numbers as strings)
//
// Errors come as { code, message, status: "error" }, with HTTP 200 or with
// the matching status: 429 is the free quota used up, 401/403 a refused key
// (or a plan that does not cover that market), 404 an unknown symbol. Every
// failure is an outcome the chain in providers/stocks.js understands, so it
// can ask the next provider:
//   { outcome: "price", ... }  { outcome: "currency" }  (found, not in that unit)
//   { outcome: "notFound" }    { outcome: "unavailable" } (quota, key, error)
// ----------------------------------------------------------------------------
const { fetchJson, baseFrom, sayOnce, debugShape } = require("./shared");
const { figiListings } = require("./openfigi");

const DEFAULT_BASE = "https://api.twelvedata.com/";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX = 5000;
// At most this many tickers are searched per ISIN: each search is a credit.
const MAX_TICKERS = 3;

// Xetra first, then these European markets (ISO 10383 MICs), then any.
const EU_MICS = new Set([
  "XETR", "XFRA", "XMIL", "XPAR", "XAMS", "XBRU", "XLIS", "XMAD",
  "XSWX", "XLON", "XWBO", "XHEL", "XSTO", "XCSE", "XOSL",
]);
// OpenFIGI's exchange codes of the same markets: their tickers are searched
// first (GY is Xetra).
const EU_EXCH = ["GY", "GR", "GF", "GD", "GM", "GS", "GH", "GI", "IM", "FP", "NA", "BB", "PL", "SM", "SQ", "SW", "SE", "LN", "AV", "FH", "SS", "DC", "NO", "ID"];

// Listings quoted in a currency's minor unit: London's GBp / GBX (pence),
// Johannesburg's ZAc (cents), Tel Aviv's ILA (agorot). Upper-cased, GBp
// became GBP and a price in pence was taken as pounds -- 100 times too high.
// They are skipped, never converted: like Eulerpool, which skips London
// altogether, a price that needs scaling is a price that can be scaled wrong.
// The case matters (GBp is pence, GBP pounds), so the raw code is compared.
const MINOR_UNITS = new Set(["GBp", "GBX", "GBx", "ZAc", "ZAC", "ILA", "ILa"]);
const isMinorUnit = (raw) => MINOR_UNITS.has(String(raw || "").trim());

const apiKey = () => String(process.env.TWELVEDATA_API_KEY || "").trim();
const twelveDataEnabled = () => Boolean(apiKey());

const url = (path, params) => {
  const u = new URL(path, baseFrom("TWELVEDATA_BASE_URL", DEFAULT_BASE));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("apikey", apiKey());
  return u.toString();
};

// (ISIN|currency) -> { listing, other } -- listing null when there is none in
// that currency, `other` when there is one in another.
const listings = new Map();
const clearTwelveData = () => listings.clear();

// null when the answer is a success, else the outcome it means. An error is
// `status: "error"` in the body or a non-2xx status, whichever comes.
const failure = (answer) => {
  if (!answer) return { outcome: "unavailable" };
  const body = answer.body;
  const bodyError = body && typeof body === "object" && !Array.isArray(body) && body.status === "error";
  if (!bodyError && answer.status >= 200 && answer.status < 300) return null;
  const code = (bodyError && Number(body.code)) || answer.status;
  if (code === 429) {
    console.log("[quotes] Twelve Data: quota used up (429), trying the next provider");
    return { outcome: "unavailable" };
  }
  if (code === 401 || code === 403) {
    sayOnce(
      `twelvedata${code}`,
      `[quotes] Twelve Data refused the key (${code}): check TWELVEDATA_API_KEY` +
        (code === 403 ? ", or the plan may not cover that market" : ""),
    );
    return { outcome: "unavailable" };
  }
  if (code === 400 || code === 404) return { outcome: "notFound" };
  console.log(`[quotes] Twelve Data: error ${code}`);
  return { outcome: "unavailable" };
};

// The ISIN's tickers, Equity first, European markets first, at most MAX_TICKERS.
const tickersOf = (figi) => {
  const rank = (l) => (l.marketSector === "Equity" ? 0 : 100) + (EU_EXCH.includes(l.exchCode) ? EU_EXCH.indexOf(l.exchCode) : 50);
  const out = [];
  for (const l of [...figi].sort((a, b) => rank(a) - rank(b))) {
    if (!out.includes(l.ticker)) out.push(l.ticker);
  }
  return out.slice(0, MAX_TICKERS);
};

const pick = (entries) =>
  entries.find((e) => e.mic === "XETR") || entries.find((e) => EU_MICS.has(e.mic)) || entries[0] || null;

// { listing, other } or a failure outcome.
const findListing = async (isin, unit, deadline) => {
  const cacheKey = `${isin}|${unit}`;
  const hit = listings.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (hit) listings.delete(cacheKey);

  const figi = await figiListings(isin, { deadline });
  if (figi === null) return { outcome: "unavailable" };
  const tickers = tickersOf(figi);

  const inUnit = [];
  let other = false;
  for (const ticker of tickers) {
    const answer = await fetchJson(url("symbol_search", { symbol: ticker }), { label: "Twelve Data", deadline });
    debugShape("Twelve Data symbol_search", answer);
    const failed = failure(answer);
    if (failed && failed.outcome === "notFound") continue;
    if (failed) return failed;
    const data = answer.body && Array.isArray(answer.body.data) ? answer.body.data : [];
    for (const e of data) {
      if (!e || String(e.symbol || "").toUpperCase() !== ticker) continue;
      const entry = {
        symbol: String(e.symbol),
        mic: String(e.mic_code || "").toUpperCase(),
        exchange: String(e.exchange || ""),
        currency: String(e.currency || "").toUpperCase(),
      };
      if (!entry.mic) continue;
      if (isMinorUnit(e.currency)) {
        other = true; // found, but not in the wallet's unit
        continue;
      }
      if (entry.currency === unit) inUnit.push(entry);
      else if (entry.currency) other = true;
    }
    if (inUnit.some((e) => e.mic === "XETR")) break; // nothing better to find
  }

  const value = { listing: pick(inUnit), other };
  listings.set(cacheKey, { value, expires: Date.now() + TTL_MS });
  while (listings.size > MAX) listings.delete(listings.keys().next().value);
  return value;
};

const num = (v) => (v == null || v === "" ? NaN : Number(v));

const lookupTwelveData = async (isin, unit, { deadline } = {}) => {
  const found = await findListing(isin, unit, deadline);
  if (found.outcome) return found;
  if (!found.listing) return { outcome: found.other ? "currency" : "notFound" };
  const { listing } = found;

  const answer = await fetchJson(url("quote", { symbol: listing.symbol, mic_code: listing.mic }), { label: "Twelve Data", deadline });
  debugShape("Twelve Data quote", answer);
  const failed = failure(answer);
  if (failed) return failed;
  const q = answer.body && typeof answer.body === "object" ? answer.body : {};

  const price = num(q.close);
  if (!Number.isFinite(price) || price <= 0) return { outcome: "notFound" };
  const answered = String(q.currency || "").trim().toUpperCase();
  if (isMinorUnit(q.currency) || (answered && answered !== listing.currency)) {
    console.log("[quotes] Twelve Data: the quote's currency is not the listing's; refused");
    return { outcome: "unavailable" };
  }
  const change = num(q.percent_change);
  return {
    outcome: "price",
    price,
    change: Number.isFinite(change) ? Number(change.toFixed(2)) : null,
    quoteCurrency: listing.currency,
    symbol: listing.mic,
    source: "twelvedata",
  };
};

module.exports = { lookupTwelveData, twelveDataEnabled, clearTwelveData, tickersOf };
