// ----------------------------------------------------------------------------
// ETFs and stocks by ISIN: the providers, tried in order
// ----------------------------------------------------------------------------
// Eulerpool first, then Twelve Data, then EODHD (QUOTES_STOCK_ORDER changes it, e.g.
// "twelvedata,eulerpool"): Twelve Data's free plan covers only a few markets,
// so for European ETFs it would mostly spend calls before Eulerpool answers.
// A provider whose key is not set is skipped. The next one is asked whenever the one before could not give a
// price in the wallet's currency: it did not find the instrument, found it
// only in other currencies, has used up its free quota, refused its key,
// failed or timed out.
//
// The result, in the shape of providers/shared.js's empty():
//   - the first price in the wallet's currency;
//   - else, if some provider found the instrument but only in other
//     currencies, unsupportedCurrency (422 CURRENCY_UNSUPPORTED);
//   - else no quote (404).
// `transient` is set when a provider could not answer (quota, key, error,
// timeout): that result says nothing definitive, and src/quotes.js does not
// keep it in its cache, so the next request asks again.
//
// The whole chain has CHAIN_BUDGET_MS, so that it ends before Bussola gives
// up on this service.
// ----------------------------------------------------------------------------
const { empty, CHAIN_BUDGET_MS } = require("./shared");
const { lookupTwelveData, twelveDataEnabled } = require("./twelvedata");
const { lookupEulerpool, eulerpoolEnabled } = require("./eulerpool");
const { lookupEodhd, eodhdEnabled } = require("./eodhd");

const ALL = {
  eulerpool: { name: "Eulerpool", enabled: eulerpoolEnabled, lookup: lookupEulerpool },
  twelvedata: { name: "Twelve Data", enabled: twelveDataEnabled, lookup: lookupTwelveData },
  eodhd: { name: "EODHD", enabled: eodhdEnabled, lookup: lookupEodhd },
};

const ordered = () => {
  const asked = String(process.env.QUOTES_STOCK_ORDER || "eulerpool,twelvedata")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/[^a-z]/g, ""))
    .filter((k) => ALL[k]);
  const order = [...new Set([...asked, "eulerpool", "twelvedata", "eodhd"])];
  return order.map((k) => ALL[k]);
};

// The names of the providers whose key is set, in the order they are tried.
const stockProviders = () => ordered().filter((p) => p.enabled()).map((p) => p.name);

const lookupStock = async (isin, currency = "EUR") => {
  const id = String(isin).toUpperCase();
  const unit = String(currency || "EUR").toUpperCase();
  const deadline = Date.now() + CHAIN_BUDGET_MS;

  let otherCurrency = false;
  let transient = false;
  for (const p of ordered()) {
    if (!p.enabled()) continue;
    const r = await p.lookup(id, unit, { deadline });
    if (r.outcome === "price") {
      const { price, change, quoteCurrency, symbol, source } = r;
      return { ...empty(), price, change, quoteCurrency, symbol, source };
    }
    if (r.outcome === "currency") otherCurrency = true;
    else if (r.outcome !== "notFound") transient = true;
  }
  if (otherCurrency) return { ...empty(), unsupportedCurrency: unit, transient };
  return { ...empty(), transient };
};

module.exports = { lookupStock, stockProviders };
