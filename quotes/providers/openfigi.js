// ----------------------------------------------------------------------------
// OpenFIGI -- ISIN -> the instrument's listings (tickers and exchanges),
// through OpenFIGI's official, free mapping API
// (https://www.openfigi.com/api/documentation). Used only by Twelve Data,
// whose free plan cannot look an ISIN up itself.
//
//   POST v3/mapping   [{ "idType": "ID_ISIN", "idValue": "<ISIN>" }]
//   ->  [ { "data": [ { figi, ticker, exchCode, name, securityType,
//                       marketSector, ... } ] } ]
//     or [ { "warning": "No identifier found." } ]
//
// No key is needed (25 requests a minute without one); OPENFIGI_API_KEY, when
// set, goes in the X-OPENFIGI-APIKEY header and raises that limit. The answer
// is kept in memory for 24 h per ISIN: which listings an ISIN has barely ever
// changes.
// ----------------------------------------------------------------------------
const { fetchJson, baseFrom, debugShape } = require("./shared");

const DEFAULT_BASE = "https://api.openfigi.com/";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX = 5000;

// ISIN -> [{ ticker, exchCode, marketSector }]. Insertion order is age order.
const cache = new Map();
const clearFigi = () => cache.clear();

// The listings, [] when OpenFIGI does not know the ISIN, null when it could
// not be asked (rate limit, error, timeout: the next lookup tries again).
const figiListings = async (isin, { deadline } = {}) => {
  const hit = cache.get(isin);
  if (hit && hit.expires > Date.now()) return hit.listings;
  if (hit) cache.delete(isin);

  const key = String(process.env.OPENFIGI_API_KEY || "").trim();
  const answer = await fetchJson(new URL("v3/mapping", baseFrom("OPENFIGI_BASE_URL", DEFAULT_BASE)).toString(), {
    label: "OpenFIGI",
    method: "POST",
    body: [{ idType: "ID_ISIN", idValue: isin }],
    headers: key ? { "X-OPENFIGI-APIKEY": key } : {},
    deadline,
  });
  debugShape("OpenFIGI mapping", answer);
  if (!answer) return null;
  if (answer.status !== 200) {
    console.log(`[quotes] OpenFIGI: HTTP ${answer.status}${answer.status === 429 ? " (rate limit)" : ""}`);
    return null;
  }
  const job = Array.isArray(answer.body) ? answer.body[0] : null;
  if (!job || typeof job !== "object") return null;

  let listings;
  if (Array.isArray(job.data)) {
    listings = job.data
      .filter((r) => r && typeof r === "object" && typeof r.ticker === "string" && r.ticker.trim())
      .map((r) => ({
        ticker: r.ticker.trim().toUpperCase(),
        exchCode: String(r.exchCode || "").trim().toUpperCase(),
        marketSector: String(r.marketSector || "").trim(),
      }));
  } else if (job.warning) {
    listings = []; // "No identifier found."
  } else {
    return null; // a job error: not an answer about the ISIN
  }

  cache.set(isin, { listings, expires: Date.now() + TTL_MS });
  while (cache.size > MAX) cache.delete(cache.keys().next().value);
  return listings;
};

module.exports = { figiListings, clearFigi };
