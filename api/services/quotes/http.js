// ----------------------------------------------------------------------------
// The quote service, over HTTP
// ----------------------------------------------------------------------------
// Bussola asks one service for every price: /v1/quote under
// BUSSOLA_QUOTES_URL. The standard one is the optional `quotes` container of
// this repository (quotes/, compose profile "quotes", reached on the compose
// network at http://quotes:8080), but anything implementing the contract below
// will do. Quotes are off (quotesEnabled()) when BUSSOLA_QUOTES_URL is unset
// or when nothing answers there (the container was never started: it is
// opt-in), and then the refresh endpoints answer 409 QUOTES_DISABLED.
//
// The contract, which is all a service has to implement:
//
//   GET <BUSSOLA_QUOTES_URL>/v1/quote?id=<ISIN or symbol>&type=<type code>&currency=<ISO 4217>
//
//   No key, no Authorization header: the service sits on the internal
//   network next to the API.
//
//   id        what the holding's ISIN field holds: an ISIN ("IE00B4L5Y983") or
//             a crypto symbol ("BTC-EUR")
//   type      the holding type's code (ETF, CRYPTO, STOCK, ...); absent when
//             the holding has no type, or one somebody invented
//   currency  the WALLET's currency, the unit the price must be in
//
//   200  { "price": 98.31, "currency": "EUR", "change": -0.42, "symbol": "XETRA" }
//
//   price     required, a positive number, in `currency`
//   currency  required, and it must be the one asked for: a price in another
//             unit would be added up with the wallet's balances as if it were
//             in theirs, so it is refused rather than trusted
//   change    optional, the day's change in percent
//   symbol    optional, shown next to the price
//
//   any non-200 status (422, say) with the body
//        { "error": "CURRENCY_UNSUPPORTED" }
//             the instrument cannot be priced in the currency asked. The
//             holding keeps its manual value, and the interface tells the
//             person why instead of claiming the service was down.
//
//   404 NO_QUOTE, 400 INVALID_REQUEST, 429, 502 UPSTREAM_FAILED -> no quote
//
// Anything else -- another status, a timeout (15 s), a body that is not that
// JSON -- counts as "no quote" too, and the holding keeps its manual value.
// ----------------------------------------------------------------------------
const { empty, fetchJson } = require("./shared");

const baseUrl = () => String(process.env.BUSSOLA_QUOTES_URL || "").trim();

// Whether something answered at the base address the last time we looked
// (null: not looked yet, taken as yes). Kept by refreshSources() below.
let reachable = null;

// On when BUSSOLA_QUOTES_URL is set and the service is not known to be down.
const quotesEnabled = () => Boolean(baseUrl()) && reachable !== false;

// The address of one endpoint, e.g. endpoint("v1/quote"). A base with a path
// keeps it (https://example.org/bussola -> .../bussola/v1/quote). Null, with a
// log line, when the configured base is not a URL.
const endpoint = (path) => {
  const base = baseUrl();
  if (!base) return null;
  try {
    return new URL(path, base.endsWith("/") ? base : `${base}/`);
  } catch {
    console.log(`[quotes] BUSSOLA_QUOTES_URL is not a URL: "${base}"`);
    return null;
  }
};

const lookupHttp = async ({ isin, typeCode, currency } = {}) => {
  const out = empty();
  if (!quotesEnabled() || !isin) return out;

  const url = endpoint("v1/quote");
  if (!url) return out;
  const unit = String(currency || "EUR").toUpperCase();
  url.searchParams.set("id", String(isin).trim());
  if (typeCode) url.searchParams.set("type", String(typeCode).toUpperCase());
  url.searchParams.set("currency", unit);

  const answer = await fetchJson(url.toString());
  if (!answer) return out;
  const data = answer.body;

  if (answer.status !== 200) {
    // The one error that is not "no quote": withReason() in the holdings
    // controller turns it into CURRENCY_UNSUPPORTED for the interface.
    if (data && typeof data === "object" && data.error === "CURRENCY_UNSUPPORTED") {
      return { ...out, unsupportedCurrency: unit };
    }
    return out;
  }
  if (!data || typeof data !== "object") return out;

  const price = Number(data.price);
  if (data.price == null || !Number.isFinite(price) || price <= 0) return out;

  const answered = String(data.currency || "").toUpperCase();
  if (answered !== unit) {
    console.log(`[quotes] ${url.host} answered in ${answered || "no currency"} for ${isin}, ${unit} was asked`);
    return out;
  }

  const change = data.change == null ? null : Number(data.change);
  return {
    ...out,
    price,
    change: Number.isFinite(change) ? change : null,
    quoteCurrency: unit,
    symbol: typeof data.symbol === "string" ? data.symbol.slice(0, 64) : null,
    source: "http",
  };
};

// Which providers the service has on (GET /v1/sources, optional: a service of
// your own may not have it), and whether it is there at all: any HTTP answer
// counts, silence does not. Only the interface depends on it, so it is a sync
// read of a cache refreshed in the background: every 5 minutes while the
// service is up, every 30 seconds while it is not (so starting the container
// later turns the buttons on soon). Empty until the first answer, and on any
// failure.
let sources = [];
let sourcesAt = 0;
let sourcesBusy = false;
const refreshSources = async () => {
  sourcesBusy = true;
  try {
    const url = endpoint("v1/sources");
    const answer = url && (await fetchJson(url.toString()));
    reachable = Boolean(answer);
    const list = answer && answer.status === 200 && answer.body && answer.body.sources;
    sources = Array.isArray(list) ? list.filter((s) => typeof s === "string").slice(0, 20) : [];
  } finally {
    sourcesAt = Date.now();
    sourcesBusy = false;
  }
};
const probeQuotes = () => (baseUrl() ? refreshSources() : Promise.resolve());
const quoteSources = () => {
  if (!baseUrl()) return [];
  const every = reachable === false ? 30 * 1000 : 5 * 60 * 1000;
  if (!sourcesBusy && Date.now() - sourcesAt > every) refreshSources().catch(() => {});
  return reachable === false ? [] : sources;
};

module.exports = { lookupHttp, quotesEnabled, quoteSources, probeQuotes };
