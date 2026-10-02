// ============================================================================
// Quotes: from the providers, through a shared cache
// ============================================================================
// The sources, all official and documented APIs:
//   - CoinGecko (providers/coingecko.js) for crypto, public, optional Demo key;
//   - ETFs and stocks by ISIN (providers/stocks.js): Eulerpool, then Twelve
//     Data, then EODHD, each with a free key the person running Bussola brings.
//
// Three layers sit between a request and a source:
//   - a cache per (id, currency, type): a price is the same for every wallet
//     on the instance. A "no quote" is cached too, for less time, so a wrong
//     ISIN retried on every refresh costs the sources one request every few
//     minutes -- but not when a provider could not answer (a spent quota, a
//     refused key, a timeout): that says nothing about the instrument;
//   - in-flight de-duplication: two identical lookups at the same moment
//     share one upstream request;
//   - a cap on concurrent upstream requests, so that a refresh of a large
//     portfolio does not burst into the sources' rate limits.
// ============================================================================
const { isIsin } = require("../providers/shared");
const { lookupCoinGecko } = require("../providers/coingecko");
const { lookupStock } = require("../providers/stocks");

// Crypto by type code, or by a symbol such as "BTC-EUR" given with no type;
// ISINs to the ETF and stock providers; anything else has no source.
const lookupBuiltIn = async ({ isin, typeCode, currency }) => {
  const isCrypto =
    String(typeCode || "").toUpperCase() === "CRYPTO" ||
    (!isIsin(isin) && String(isin).includes("-"));
  if (isCrypto) return lookupCoinGecko(isin, currency);
  if (isIsin(isin)) return lookupStock(isin, currency);
  return null;
};

// The tests replace the providers with a stub; nothing else does.
let lookup = lookupBuiltIn;
const setLookup = (fn) => {
  lookup = fn || lookupBuiltIn;
};

// A provider's answer turned into the contract's: a status and a body.
const toAnswer = (result, currency) => {
  if (result && result.unsupportedCurrency) {
    return { status: 422, body: { error: "CURRENCY_UNSUPPORTED" } };
  }
  const price = result ? Number(result.price) : NaN;
  // The unit is checked here as well as by the app: a price in another
  // currency would be summed with the wallet's balances as if it were theirs.
  if (result && result.price != null && Number.isFinite(price) && price > 0 && result.quoteCurrency === currency) {
    const change = result.change == null ? null : Number(result.change);
    return {
      status: 200,
      body: {
        price,
        currency,
        change: Number.isFinite(change) ? change : null,
        symbol: typeof result.symbol === "string" ? result.symbol.slice(0, 64) : null,
      },
    };
  }
  return { status: 404, body: { error: "NO_QUOTE" } };
};

const createQuotes = ({ cacheSeconds = 900, negativeSeconds = 300, cacheMax = 5000, concurrency = 4, log = console.log } = {}) => {
  // Insertion order is age order, so the first key is the oldest entry.
  const cache = new Map();
  const inflight = new Map();

  let active = 0;
  const waiting = [];
  const acquire = () => {
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  // A slot is handed straight to the next waiter rather than freed and
  // re-taken, so a newcomer cannot jump the queue.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  const remember = (key, answer) => {
    // A refused currency is as stable as a price, a "no quote" may be a
    // source's bad minute: it is kept for less time.
    const seconds = answer.status === 404 ? Math.min(negativeSeconds, cacheSeconds) : cacheSeconds;
    if (seconds <= 0) return;
    cache.delete(key);
    cache.set(key, { answer, expires: Date.now() + seconds * 1000 });
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
  };

  const fetchAnswer = async (key, { id, type, currency }) => {
    await acquire();
    try {
      const result = await lookup({ isin: id, typeCode: type || null, currency });
      const answer = toAnswer(result, currency);
      // A price is kept whatever happened on the way; a "no quote" only when
      // every provider asked gave a definitive answer.
      if (answer.status === 200 || !(result && result.transient)) remember(key, answer);
      return answer;
    } catch (e) {
      // The providers never throw; if one ever does, the caller gets a 502
      // and nothing is cached, so the next request tries again. The message
      // only, never the instrument.
      log(`[quotes] lookup failed: ${e.message}`);
      return { status: 502, body: { error: "UPSTREAM_FAILED" } };
    } finally {
      release();
    }
  };

  // { answer, cached } for an already validated (id, type, currency).
  const get = async (query) => {
    const key = `${query.id}|${query.currency}|${query.type || ""}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return { answer: hit.answer, cached: true };
    if (hit) cache.delete(key);

    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchAnswer(key, query).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return { answer: await pending, cached: false };
  };

  return { get, size: () => cache.size, clear: () => cache.clear() };
};

module.exports = { createQuotes, setLookup, lookupBuiltIn, toAnswer };
